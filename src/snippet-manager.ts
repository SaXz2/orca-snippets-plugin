// CodeMirror 6 imports
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, highlightSpecialChars, drawSelection, dropCursor, highlightActiveLine, keymap, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { history, historyKeymap, indentWithTab, defaultKeymap } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, indentUnit } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";

/**
 * 代码片段数据结构
 */
export interface Snippet {
  id: string;
  name: string;
  content: string;
  type: "css" | "js";
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface SnippetSettings {
  cssEnabled: boolean;
  jsEnabled: boolean;
}

interface TrackedEventListener {
  target: EventTarget;
  type: string;
  listener: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
}

interface TrackedAnimationFrame {
  id: number;
}

interface TrackedListenerRecord extends TrackedEventListener {
  originalListener: EventListenerOrEventListenerObject;
  context: JsSnippetContext;
}

interface JsSnippetContext {
  snippetId: string;
  cleanups: Set<() => void>;
  eventListeners: TrackedEventListener[];
  timeouts: number[];
  intervals: number[];
  animationFrames: TrackedAnimationFrame[];
  observers: { disconnect: () => void }[];
  createdNodes: Node[];
  disposed: boolean;
}

type OriginalRuntimeApis = {
  addEventListener: typeof EventTarget.prototype.addEventListener;
  removeEventListener: typeof EventTarget.prototype.removeEventListener;
  setTimeout: typeof window.setTimeout;
  clearTimeout: typeof window.clearTimeout;
  setInterval: typeof window.setInterval;
  clearInterval: typeof window.clearInterval;
  requestAnimationFrame: typeof window.requestAnimationFrame;
  cancelAnimationFrame: typeof window.cancelAnimationFrame;
  MutationObserver?: typeof MutationObserver;
  ResizeObserver?: typeof ResizeObserver;
  IntersectionObserver?: typeof IntersectionObserver;
  createElement: typeof Document.prototype.createElement;
  createElementNS: typeof Document.prototype.createElementNS;
  createTextNode: typeof Document.prototype.createTextNode;
};

/**
 * 代码片段管理器
 * 负责代码片段的存储、加载、注入和管理界面
 */
export class SnippetManager {
  private pluginName: string;
  private snippets: Map<string, Snippet> = new Map();
  private injectedElements: Map<string, HTMLElement> = new Map();
  private jsContexts: Map<string, JsSnippetContext> = new Map();
  private listenerRecords: TrackedListenerRecord[] = [];
  private settings: SnippetSettings = { cssEnabled: true, jsEnabled: true };
  private runtimePatched = false;
  private activeJsContext: JsSnippetContext | null = null;
  private originalRuntimeApis: OriginalRuntimeApis | null = null;

  constructor(pluginName: string) {
    this.pluginName = pluginName;
  }

  /**
   * 初始化：从存储中加载所有代码片段
   */
  async init() {
    try {
      const data = await orca.plugins.getData(this.pluginName, "snippets");
      if (data) {
        const snippetsArray: Snippet[] = JSON.parse(data);
        snippetsArray.forEach((snippet) => {
          this.snippets.set(snippet.id, snippet);
        });
      }
    } catch (error) {
      // Silently fail to load snippets
    }

    try {
      const data = await orca.plugins.getData(this.pluginName, "settings");
      if (data) {
        const settings = JSON.parse(data) as Partial<SnippetSettings>;
        this.settings = {
          cssEnabled: settings.cssEnabled ?? true,
          jsEnabled: settings.jsEnabled ?? true,
        };
      }
    } catch (error) {
      this.settings = { cssEnabled: true, jsEnabled: true };
    }
  }

  /**
   * 保存所有代码片段到存储
   */
  private async saveSnippets() {
    const snippetsArray = Array.from(this.snippets.values());
    const dataStr = JSON.stringify(snippetsArray);
    
    // 检查数据大小（MB）
    const dataSizeMB = new Blob([dataStr]).size / 1024 / 1024;
    if (dataSizeMB > 1) {
      // Data size warning skipped
    }
    
    await orca.plugins.setData(
      this.pluginName,
      "snippets",
      dataStr
    );
  }

  private async saveSettings() {
    await orca.plugins.setData(
      this.pluginName,
      "settings",
      JSON.stringify(this.settings)
    );
  }

  getSettings(): SnippetSettings {
    return { ...this.settings };
  }

  async setTypeEnabled(type: "css" | "js", enabled: boolean) {
    if (type === "css") {
      this.settings.cssEnabled = enabled;
      if (enabled) {
        this.loadEnabledByType("css");
      } else {
        this.cleanupByType("css");
      }
    } else {
      this.settings.jsEnabled = enabled;
      if (enabled) {
        this.loadEnabledByType("js");
      } else {
        this.cleanupByType("js");
      }
    }

    await this.saveSettings();
  }

  private isTypeGloballyEnabled(type: "css" | "js") {
    return type === "css" ? this.settings.cssEnabled : this.settings.jsEnabled;
  }

  private loadEnabledByType(type: "css" | "js") {
    for (const snippet of this.snippets.values()) {
      if (snippet.type === type && snippet.enabled) {
        this.injectSnippet(snippet);
      }
    }
  }

  private cleanupByType(type: "css" | "js") {
    for (const snippet of this.snippets.values()) {
      if (snippet.type === type) {
        this.removeSnippet(snippet.id);
      }
    }
  }

  private createJsContext(snippetId: string): JsSnippetContext {
    const context: JsSnippetContext = {
      snippetId,
      cleanups: new Set(),
      eventListeners: [],
      timeouts: [],
      intervals: [],
      animationFrames: [],
      observers: [],
      createdNodes: [],
      disposed: false,
    };

    this.jsContexts.set(snippetId, context);
    return context;
  }

  private runWithJsContext<T>(context: JsSnippetContext, callback: () => T): T {
    const previousContext = this.activeJsContext;
    this.activeJsContext = context;
    try {
      return callback();
    } finally {
      this.activeJsContext = previousContext;
    }
  }

  private ensureRuntimeTracking() {
    if (this.runtimePatched) return;

    const original: OriginalRuntimeApis = {
      addEventListener: EventTarget.prototype.addEventListener,
      removeEventListener: EventTarget.prototype.removeEventListener,
      setTimeout: window.setTimeout,
      clearTimeout: window.clearTimeout,
      setInterval: window.setInterval,
      clearInterval: window.clearInterval,
      requestAnimationFrame: window.requestAnimationFrame,
      cancelAnimationFrame: window.cancelAnimationFrame,
      MutationObserver: window.MutationObserver,
      ResizeObserver: window.ResizeObserver,
      IntersectionObserver: window.IntersectionObserver,
      createElement: Document.prototype.createElement,
      createElementNS: Document.prototype.createElementNS,
      createTextNode: Document.prototype.createTextNode,
    };
    this.originalRuntimeApis = original;

    const manager = this;

    EventTarget.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ) {
      const context = manager.activeJsContext;
      if (!context || !listener) {
        return original.addEventListener.call(this, type, listener, options);
      }

      const wrappedListener: EventListenerOrEventListenerObject =
        typeof listener === "function"
          ? function (this: EventTarget, event: Event) {
              return manager.runWithJsContext(context, () => listener.call(this, event));
            }
          : {
              handleEvent(event: Event) {
                return manager.runWithJsContext(context, () => listener.handleEvent(event));
              },
            };

      const record: TrackedListenerRecord = {
        target: this,
        type,
        listener: wrappedListener,
        originalListener: listener,
        options,
        context,
      };

      context.eventListeners.push(record);
      manager.listenerRecords.push(record);
      return original.addEventListener.call(this, type, wrappedListener, options);
    };

    EventTarget.prototype.removeEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions
    ) {
      const index = manager.listenerRecords.findIndex((record) =>
        record.target === this &&
        record.type === type &&
        record.originalListener === listener
      );

      if (index >= 0) {
        const [record] = manager.listenerRecords.splice(index, 1);
        const contextIndex = record.context.eventListeners.indexOf(record);
        if (contextIndex >= 0) {
          record.context.eventListeners.splice(contextIndex, 1);
        }
        return original.removeEventListener.call(this, type, record.listener, options);
      }

      return original.removeEventListener.call(this, type, listener, options);
    };

    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      const context = manager.activeJsContext;
      let timerId = 0;
      const wrappedHandler =
        typeof handler === "function"
          ? (...handlerArgs: any[]) => {
              if (context) {
                context.timeouts = context.timeouts.filter((id) => id !== timerId);
                return manager.runWithJsContext(context, () => handler.apply(window, handlerArgs));
              }
              return handler.apply(window, handlerArgs);
            }
          : handler;

      timerId = original.setTimeout.call(window, wrappedHandler as TimerHandler, timeout, ...args);
      if (context) {
        context.timeouts.push(timerId);
      }
      return timerId;
    }) as typeof window.setTimeout;

    window.clearTimeout = ((id?: number) => {
      if (id != null) {
        for (const context of manager.jsContexts.values()) {
          context.timeouts = context.timeouts.filter((timerId) => timerId !== id);
        }
      }
      return original.clearTimeout.call(window, id);
    }) as typeof window.clearTimeout;

    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      const context = manager.activeJsContext;
      const wrappedHandler =
        typeof handler === "function" && context
          ? (...handlerArgs: any[]) => manager.runWithJsContext(context, () => handler.apply(window, handlerArgs))
          : handler;
      const intervalId = original.setInterval.call(window, wrappedHandler as TimerHandler, timeout, ...args);
      if (context) {
        context.intervals.push(intervalId);
      }
      return intervalId;
    }) as typeof window.setInterval;

    window.clearInterval = ((id?: number) => {
      if (id != null) {
        for (const context of manager.jsContexts.values()) {
          context.intervals = context.intervals.filter((intervalId) => intervalId !== id);
        }
      }
      return original.clearInterval.call(window, id);
    }) as typeof window.clearInterval;

    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const context = manager.activeJsContext;
      let frameId = 0;
      const wrappedCallback: FrameRequestCallback = (time) => {
        if (context) {
          context.animationFrames = context.animationFrames.filter((frame) => frame.id !== frameId);
          return manager.runWithJsContext(context, () => callback(time));
        }
        return callback(time);
      };

      frameId = original.requestAnimationFrame.call(window, wrappedCallback);
      if (context) {
        context.animationFrames.push({ id: frameId });
      }
      return frameId;
    }) as typeof window.requestAnimationFrame;

    window.cancelAnimationFrame = ((id: number) => {
      for (const context of manager.jsContexts.values()) {
        context.animationFrames = context.animationFrames.filter((frame) => frame.id !== id);
      }
      return original.cancelAnimationFrame.call(window, id);
    }) as typeof window.cancelAnimationFrame;

    this.patchObserver("MutationObserver", original.MutationObserver);
    this.patchObserver("ResizeObserver", original.ResizeObserver);
    this.patchObserver("IntersectionObserver", original.IntersectionObserver);

    Document.prototype.createElement = function (
      this: Document,
      ...args: Parameters<typeof Document.prototype.createElement>
    ) {
      const element = original.createElement.apply(this, args);
      const context = manager.activeJsContext;
      if (context) {
        context.createdNodes.push(element);
      }
      return element;
    } as typeof Document.prototype.createElement;

    Document.prototype.createElementNS = function (
      this: Document,
      ...args: Parameters<typeof Document.prototype.createElementNS>
    ) {
      const element = original.createElementNS.apply(this, args as any);
      const context = manager.activeJsContext;
      if (context) {
        context.createdNodes.push(element);
      }
      return element;
    } as typeof Document.prototype.createElementNS;

    Document.prototype.createTextNode = function (
      this: Document,
      ...args: Parameters<typeof Document.prototype.createTextNode>
    ) {
      const node = original.createTextNode.apply(this, args);
      const context = manager.activeJsContext;
      if (context) {
        context.createdNodes.push(node);
      }
      return node;
    } as typeof Document.prototype.createTextNode;

    this.runtimePatched = true;
  }

  private patchObserver(
    name: "MutationObserver" | "ResizeObserver" | "IntersectionObserver",
    OriginalObserver: any
  ) {
    if (!OriginalObserver) return;

    const manager = this;
    (window as any)[name] = class extends OriginalObserver {
      constructor(callback: (...args: any[]) => void) {
        const context = manager.activeJsContext;
        super(
          context
            ? (...args: any[]) => manager.runWithJsContext(context, () => callback(...args))
            : callback
        );

        if (context) {
          context.observers.push(this as unknown as { disconnect: () => void });
        }
      }
    };
  }

  private restoreRuntimeTrackingIfIdle() {
    if (!this.runtimePatched || this.jsContexts.size > 0 || !this.originalRuntimeApis) return;

    EventTarget.prototype.addEventListener = this.originalRuntimeApis.addEventListener;
    EventTarget.prototype.removeEventListener = this.originalRuntimeApis.removeEventListener;
    window.setTimeout = this.originalRuntimeApis.setTimeout;
    window.clearTimeout = this.originalRuntimeApis.clearTimeout;
    window.setInterval = this.originalRuntimeApis.setInterval;
    window.clearInterval = this.originalRuntimeApis.clearInterval;
    window.requestAnimationFrame = this.originalRuntimeApis.requestAnimationFrame;
    window.cancelAnimationFrame = this.originalRuntimeApis.cancelAnimationFrame;
    Document.prototype.createElement = this.originalRuntimeApis.createElement;
    Document.prototype.createElementNS = this.originalRuntimeApis.createElementNS;
    Document.prototype.createTextNode = this.originalRuntimeApis.createTextNode;
    if (this.originalRuntimeApis.MutationObserver) {
      window.MutationObserver = this.originalRuntimeApis.MutationObserver;
    }
    if (this.originalRuntimeApis.ResizeObserver) {
      window.ResizeObserver = this.originalRuntimeApis.ResizeObserver;
    }
    if (this.originalRuntimeApis.IntersectionObserver) {
      window.IntersectionObserver = this.originalRuntimeApis.IntersectionObserver;
    }

    this.originalRuntimeApis = null;
    this.runtimePatched = false;
  }

  private cleanupJsContext(snippetId: string) {
    const context = this.jsContexts.get(snippetId);
    if (!context) return;

    context.disposed = true;
    const original = this.originalRuntimeApis;

    for (const cleanup of Array.from(context.cleanups)) {
      try {
        cleanup();
      } catch (error: any) {
        orca.notify("error", `清理 JS 片段时出错：${error?.message || String(error)}`, {
          title: "代码片段清理失败",
        });
      }
    }
    context.cleanups.clear();

    for (const record of [...context.eventListeners]) {
      try {
        (original?.removeEventListener ?? EventTarget.prototype.removeEventListener).call(
          record.target,
          record.type,
          record.listener,
          record.options
        );
      } catch (error) {
        // Ignore cleanup failures from detached targets.
      }
    }

    this.listenerRecords = this.listenerRecords.filter((record) => record.context !== context);
    context.eventListeners = [];

    for (const timeoutId of context.timeouts) {
      (original?.clearTimeout ?? window.clearTimeout).call(window, timeoutId);
    }
    context.timeouts = [];

    for (const intervalId of context.intervals) {
      (original?.clearInterval ?? window.clearInterval).call(window, intervalId);
    }
    context.intervals = [];

    for (const frame of context.animationFrames) {
      (original?.cancelAnimationFrame ?? window.cancelAnimationFrame).call(window, frame.id);
    }
    context.animationFrames = [];

    for (const observer of context.observers) {
      try {
        observer.disconnect();
      } catch (error) {
        // Ignore cleanup failures from observers that are already disconnected.
      }
    }
    context.observers = [];

    for (const node of context.createdNodes) {
      try {
        if (node.isConnected && node.parentNode) {
          node.parentNode.removeChild(node);
        }
      } catch (error) {
        // Ignore nodes that were already moved or removed.
      }
    }
    context.createdNodes = [];

    this.jsContexts.delete(snippetId);
    this.restoreRuntimeTrackingIfIdle();
  }

  /**
   * 加载所有启用的代码片段
   */
  async loadAllEnabled() {
    for (const snippet of this.snippets.values()) {
      if (snippet.enabled && this.isTypeGloballyEnabled(snippet.type)) {
        this.injectSnippet(snippet);
      }
    }
  }

  /**
   * 清理所有注入的代码片段
   */
  cleanup() {
    for (const snippetId of Array.from(this.injectedElements.keys())) {
      this.removeSnippet(snippetId);
    }
    for (const snippetId of Array.from(this.jsContexts.keys())) {
      this.cleanupJsContext(snippetId);
    }
    this.injectedElements.clear();
  }

  /**
   * 检查代码是否需要等待 DOM 就绪
   */
  private checkIfNeedsDOMReady(code: string): boolean {
    // 检查代码中是否包含 DOM 操作相关的关键词
    const domKeywords = [
      "querySelector",
      "getElementById",
      "getElementsByClassName",
      "getElementsByTagName",
      "addEventListener",
      "MutationObserver",
      "document.body",
      "document.head",
      ".getBoundingClientRect",
      ".appendChild",
      ".insertBefore",
      ".classList",
    ];
    
    const lowerCode = code.toLowerCase();
    return domKeywords.some((keyword) => lowerCode.includes(keyword.toLowerCase()));
  }

  /**
   * 验证 JavaScript 代码
   */
  private validateJavaScript(code: string): { valid: boolean; error?: string } {
    if (!code || !code.trim()) {
      return {
        valid: false,
        error: "代码为空",
      };
    }

    try {
      // 使用 Function 构造函数来检查基本语法
      // 注意：这会捕获一些语法错误，但不是所有错误
      // 例如，顶层的 return 语句会失败，但浏览器可以执行
      new Function(code);
      return { valid: true };
    } catch (error: any) {
      // 即使验证失败，也允许注入，因为浏览器可能有更宽松的解析
      // 但记录警告信息
      return {
        valid: false,
        error: error.message || "可能存在语法问题",
      };
    }
  }

  /**
   * 注入代码片段到页面
   */
  private injectSnippet(snippet: Snippet) {
    // 移除旧的元素（如果存在）
    this.removeSnippet(snippet.id);

    if (!this.isTypeGloballyEnabled(snippet.type)) {
      return;
    }

    const elementId = `${this.pluginName}-snippet-${snippet.id}`;

    if (snippet.type === "css") {
      // 注入 CSS
      const styleElement = document.createElement("style");
      styleElement.id = elementId;
      styleElement.textContent = snippet.content;
      document.head.appendChild(styleElement);
      this.injectedElements.set(snippet.id, styleElement);
    } else if (snippet.type === "js") {
      // 验证 JavaScript（宽松验证，只检查明显错误）
      const validation = this.validateJavaScript(snippet.content);
      if (!validation.valid) {
        // 即使验证失败，也尝试注入（因为有些代码 Function 构造函数无法解析，但浏览器可以执行）
      }

      // 注入 JavaScript
      try {
        // 检查代码是否需要等待 DOM 就绪
        const needsDOMReady = this.checkIfNeedsDOMReady(snippet.content);
        const context = this.createJsContext(snippet.id);
        
        // 使用 Function 构造函数执行代码（利用 unsafe-eval 权限）
        const executeCode = () => {
          try {
            if (context.disposed) return;
            this.ensureRuntimeTracking();
            const cleanupApi = {
              onCleanup: (cleanup: () => void) => {
                if (typeof cleanup === "function") {
                  context.cleanups.add(cleanup);
                }
              },
              cleanup: (cleanup: () => void) => {
                if (typeof cleanup === "function") {
                  context.cleanups.add(cleanup);
                }
              },
            };
            // 创建一个函数来执行代码片段
            const func = new Function("ctx", snippet.content);
            const maybeCleanup = this.runWithJsContext(context, () => func(cleanupApi));
            if (typeof maybeCleanup === "function") {
              context.cleanups.add(maybeCleanup);
            }
          } catch (error: any) {
            orca.notify(
              "error",
              `「${snippet.name}」运行出错：${error.message}`,
              { title: "代码片段错误" }
            );
          }
        };
        
        if (needsDOMReady) {
          // 需要等待 DOM 就绪
          if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", executeCode);
            context.cleanups.add(() => document.removeEventListener("DOMContentLoaded", executeCode));
          } else if (document.readyState === "complete") {
            // DOM 已完全加载，立即执行
            executeCode();
          } else {
            // DOM 已解析但可能还未完全渲染，使用 requestAnimationFrame 确保在下一帧执行（比 setTimeout 更快）
            const frameId = requestAnimationFrame(executeCode);
            context.animationFrames.push({ id: frameId });
          }
        } else {
          // 不需要等待 DOM，立即执行
          executeCode();
        }
        
        // 不创建 script 元素，直接使用 div 元素来追踪
        // 这样可以避免 CSP 错误
        const trackerElement = document.createElement("div");
        trackerElement.id = elementId;
        trackerElement.style.display = "none";
        trackerElement.setAttribute("data-snippet-name", snippet.name);
        trackerElement.setAttribute("data-snippet-type", "js");
        document.body.appendChild(trackerElement);
        this.injectedElements.set(snippet.id, trackerElement);
      } catch (error: any) {
        orca.notify(
          "error",
          `注入 JS 片段「${snippet.name}」失败：${error.message}`,
          { title: "代码片段错误" }
        );
      }
    }
  }

  /**
   * 移除代码片段
   */
  private removeSnippet(snippetId: string) {
    this.cleanupJsContext(snippetId);
    const element = this.injectedElements.get(snippetId);
    if (element) {
      element.remove();
      this.injectedElements.delete(snippetId);
    }
  }

  /**
   * 添加代码片段
   */
  async addSnippet(snippet: Omit<Snippet, "id" | "createdAt" | "updatedAt">) {
    const now = Date.now();
    const newSnippet: Snippet = {
      ...snippet,
      id: `snippet-${now}-${Math.random().toString(36).substr(2, 9)}`,
      createdAt: now,
      updatedAt: now,
    };

    this.snippets.set(newSnippet.id, newSnippet);
    await this.saveSnippets();

    if (newSnippet.enabled) {
      this.injectSnippet(newSnippet);
    }

    return newSnippet;
  }

  /**
   * 更新代码片段
   */
  async updateSnippet(
    snippetId: string,
    updates: Partial<Omit<Snippet, "id" | "createdAt">>
  ) {
    const snippet = this.snippets.get(snippetId);
    if (!snippet) {
      throw new Error(`未找到代码片段 ${snippetId}`);
    }

    const updatedSnippet: Snippet = {
      ...snippet,
      ...updates,
      updatedAt: Date.now(),
    };

    this.snippets.set(snippetId, updatedSnippet);
    await this.saveSnippets();

    // 如果启用了，重新注入
    if (updatedSnippet.enabled) {
      this.injectSnippet(updatedSnippet);
    } else {
      // 如果禁用了，移除
      this.removeSnippet(snippetId);
    }

    return updatedSnippet;
  }

  /**
   * 删除代码片段
   */
  async deleteSnippet(snippetId: string) {
    this.removeSnippet(snippetId);
    this.snippets.delete(snippetId);
    await this.saveSnippets();
  }

  /**
   * 切换代码片段的启用状态
   */
  async toggleSnippet(snippetId: string) {
    const snippet = this.snippets.get(snippetId);
    if (!snippet) {
      throw new Error(`未找到代码片段 ${snippetId}`);
    }

    return await this.updateSnippet(snippetId, {
      enabled: !snippet.enabled,
    });
  }

  /**
   * 获取所有代码片段
   */
  getAllSnippets(): Snippet[] {
    return Array.from(this.snippets.values()).sort((a, b) => {
      // 按创建时间排序，如果创建时间相同则按更新时间排序
      if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt;
      }
      return a.updatedAt - b.updatedAt;
    });
  }

  /**
   * 获取代码片段
   */
  getSnippet(snippetId: string): Snippet | undefined {
    return this.snippets.get(snippetId);
  }

  /**
   * 导出所有代码片段为 JSON 文件
   */
  exportSnippets() {
    const snippetsArray = this.getAllSnippets();
    const dataStr = JSON.stringify(snippetsArray, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `snippets-${new Date().toISOString().split("T")[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  exportSnippet(snippetId: string) {
    const snippet = this.snippets.get(snippetId);
    if (!snippet) {
      throw new Error("未找到这个代码片段");
    }

    const dataStr = JSON.stringify(snippet, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const safeName = (snippet.name || snippet.type)
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .slice(0, 80) || snippet.type;

    link.href = url;
    link.download = `snippet-${safeName}-${new Date().toISOString().split("T")[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /**
   * 从 JSON 文件导入代码片段
   */
  async importSnippets(file: File): Promise<{ success: number; failed: number; errors: string[] }> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const result = e.target?.result as string;
        let importedSnippets: Snippet[] = [];
        const errors: string[] = [];
        let success = 0;
        let failed = 0;

        try {
          const parsed = JSON.parse(result);
          importedSnippets = Array.isArray(parsed) ? parsed : [parsed];

          for (const snippet of importedSnippets) {
            try {
              // 验证代码片段结构
              if (!snippet.name || !snippet.content || !snippet.type) {
                throw new Error("缺少名称、内容或类型");
              }

              if (snippet.type !== "css" && snippet.type !== "js") {
                throw new Error(`不支持的片段类型：${snippet.type}`);
              }

              // 生成新的 ID（避免 ID 冲突）
              const now = Date.now();
              // 如果导入的文件中有 createdAt，保留它（这样可以保持原有的顺序）
              // 如果没有，使用递增的时间戳来保持导入顺序
              const baseTime = now + success * 1000; // 每个代码片段间隔1秒，确保顺序
              const newSnippet: Snippet = {
                id: `snippet-${now}-${Math.random().toString(36).substr(2, 9)}`,
                name: snippet.name,
                content: snippet.content,
                type: snippet.type,
                enabled: snippet.enabled ?? false,
                createdAt: snippet.createdAt ?? baseTime,
                updatedAt: snippet.updatedAt ?? baseTime,
              };

              this.snippets.set(newSnippet.id, newSnippet);
              success++;

              // 如果启用了，立即注入
              if (newSnippet.enabled) {
                this.injectSnippet(newSnippet);
              }
            } catch (error: any) {
              failed++;
              errors.push(`片段「${snippet.name || "未命名"}」：${error.message}`);
            }
          }

          // 保存所有导入的代码片段
          if (success > 0) {
            await this.saveSnippets();
          }

          resolve({ success, failed, errors });
        } catch (error: any) {
          resolve({
            success: 0,
            failed: importedSnippets.length || 1,
            errors: [error.message || "无法解析 JSON 文件"],
          });
        }
      };
      reader.onerror = () => {
        resolve({
          success: 0,
          failed: 0,
          errors: ["读取文件失败"],
        });
      };
      reader.readAsText(file);
    });
  }

  // 管理弹出菜单的状态
  private managerPopupVisible = false;
  private managerButtonRef: React.RefObject<HTMLElement> | null = null;

  /**
   * 打开代码片段管理器
   */
  async openManager() {
    const React = window.React;
    if (!React) {
      return;
    }
    
    const Button = orca.components.Button;
    const Input = orca.components.Input;
    const Select = orca.components.Select;
    const Segmented = orca.components.Segmented;
    const Switch = orca.components.Switch;
    const Popup = orca.components.Popup;
    const ModalOverlay = orca.components.ModalOverlay;
    const Menu = orca.components.Menu;
    const MenuText = orca.components.MenuText;

    // 如果已经有打开的菜单，先关闭
    if (this.managerPopupVisible) {
      this.managerPopupVisible = false;
      // 清理管理器容器
      const container = document.getElementById(`${this.pluginName}-manager-container`);
      if (container) {
        const root = (container as any)._reactRootContainer;
        if (root) {
          root.unmount();
        }
        container.remove();
      }
      // 清理编辑对话框容器
      const editContainer = document.getElementById(`${this.pluginName}-edit-container`);
      if (editContainer) {
        const editRoot = (editContainer as any)._reactRootContainer;
        if (editRoot) {
          try {
            editRoot.unmount();
          } catch (e) {
            // Error unmounting edit root
          }
        }
        editContainer.remove();
      }
      return;
    }
    
    // 清理可能存在的旧编辑对话框容器（如果管理器未打开但编辑对话框还在）
    const existingEditContainer = document.getElementById(`${this.pluginName}-edit-container`);
    if (existingEditContainer) {
      const existingEditRoot = (existingEditContainer as any)._reactRootContainer;
      if (existingEditRoot) {
        try {
          existingEditRoot.unmount();
        } catch (e) {
          // Error unmounting existing edit root
        }
      }
      existingEditContainer.remove();
    }

    // 创建一个按钮引用用于定位 Popup
    if (!this.managerButtonRef) {
      this.managerButtonRef = React.createRef<HTMLElement>();
    }

    const ManagerMenu = () => {
      const [snippets, setSnippets] = React.useState<Snippet[]>(
        this.getAllSnippets()
      );
      const [visible, setVisible] = React.useState(true);
      const [snippetType, setSnippetType] = React.useState<"css" | "js">("css");
      const [searchQuery, setSearchQuery] = React.useState("");
      const [showSearch, setShowSearch] = React.useState(false);
      const importInputRef = React.useRef<HTMLInputElement>(null);
      const [showMoreMenu, setShowMoreMenu] = React.useState(false);
      const moreMenuButtonRef = React.useRef<HTMLElement>(null);
      const [settings, setSettings] = React.useState<SnippetSettings>(
        this.getSettings()
      );

      // 监听刷新事件
      React.useEffect(() => {
        const handleRefresh = () => {
          setSnippets(this.getAllSnippets());
        };
        window.addEventListener(`${this.pluginName}-refresh` as any, handleRefresh);
        return () => {
          window.removeEventListener(`${this.pluginName}-refresh` as any, handleRefresh);
        };
      }, []);

      // 计算计数
      const cssCount = snippets.filter((s: Snippet) => s.type === "css").length;
      const jsCount = snippets.filter((s: Snippet) => s.type === "js").length;
      const currentTypeEnabled = snippetType === "css" ? settings.cssEnabled : settings.jsEnabled;
      
      // 筛选代码片段
      const filteredSnippets = snippets.filter((snippet: Snippet) => {
        const typeMatch = snippet.type === snippetType;
        const searchMatch = !searchQuery || 
          snippet.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          snippet.content.toLowerCase().includes(searchQuery.toLowerCase());
        return typeMatch && searchMatch;
      });

      const handleDelete = async (snippetId: string) => {
        try {
          await this.deleteSnippet(snippetId);
          orca.notify("success", "代码片段已删除");
          setSnippets(this.getAllSnippets());
        } catch (error: any) {
          orca.notify("error", `删除代码片段失败：${error.message}`);
        }
      };

      const handleToggle = async (snippetId: string) => {
        try {
          await this.toggleSnippet(snippetId);
          setSnippets(this.getAllSnippets());
        } catch (error: any) {
          orca.notify("error", `切换代码片段失败：${error.message}`);
        }
      };

      const handleTypeToggle = async (type: "css" | "js", enabled: boolean) => {
        try {
          await this.setTypeEnabled(type, enabled);
          setSettings(this.getSettings());
          setSnippets(this.getAllSnippets());
          orca.notify("success", `${type.toUpperCase()} 总开关已${enabled ? "开启" : "关闭"}`);
        } catch (error: any) {
          orca.notify("error", `切换 ${type.toUpperCase()} 总开关失败：${error.message}`);
        }
      };

      const openAddDialog = (close: () => void) => {
        close();
        window.dispatchEvent(new CustomEvent(`${this.pluginName}-open-edit`, {
          detail: { type: "add", defaultType: snippetType }
        }));
      };

      const openEditDialog = (snippet: Snippet, close: () => void) => {
        close();
        window.dispatchEvent(new CustomEvent(`${this.pluginName}-open-edit`, {
          detail: { type: "edit", snippet }
        }));
      };

      const handleClose = () => {
        setVisible(false);
        this.managerPopupVisible = false;
      };
      
      // 清理函数：当组件卸载时
      React.useEffect(() => {
        return () => {
          if (!visible) {
            this.managerPopupVisible = false;
            // 清理容器
            const container = document.getElementById(`${this.pluginName}-manager-container`);
            if (container) {
              const root = (container as any)._reactRootContainer;
              if (root) {
                try {
                  root.unmount();
                } catch (e) {
                  // Error unmounting root
                }
              }
            }
          }
        };
      }, [visible]);

      // 获取按钮元素
      const getButtonElement = (): HTMLElement | null => {
        let buttonElement: HTMLElement | null = this.managerButtonRef?.current || null;
        
        if (!buttonElement) {
          buttonElement = document.querySelector(`button[data-plugin-button="${this.pluginName}.headbarButton"]`) as HTMLElement;
        }
        
        if (!buttonElement) {
          const buttons = document.querySelectorAll('button, [role="button"]');
          for (const btn of Array.from(buttons)) {
            const icon = btn.querySelector('i.ti-code, i[class*="code"]');
            if (icon) {
              buttonElement = btn as HTMLElement;
              break;
            }
          }
        }
        
        return buttonElement;
      };
      
      // 使用 useState 存储按钮引用
      const [buttonElement, setButtonElement] = React.useState<HTMLElement | null>(() => getButtonElement());
      const buttonRef = React.useRef<HTMLElement | null>(buttonElement);
      
      React.useEffect(() => {
        // 更新按钮引用
        const element = getButtonElement();
        if (element) {
          buttonRef.current = element;
          setButtonElement(element);
        }
        // 延迟再更新一次，确保DOM已完全更新
        const timer = setTimeout(() => {
          const element = getButtonElement();
          if (element) {
            buttonRef.current = element;
            setButtonElement(element);
          }
        }, 50);
        return () => clearTimeout(timer);
      }, [visible]);
      
      // 如果按钮元素不存在或不可见，不显示 Popup
      const currentButton = buttonElement || getButtonElement();
      if (!currentButton || !visible) {
        return null;
      }
      
      // 更新 ref
      buttonRef.current = currentButton;
      return React.createElement(
        Popup,
        {
          refElement: buttonRef as any,
          visible: visible,
          onClose: () => {
            handleClose();
          },
          onClosed: () => {
            this.managerPopupVisible = false;
            // 确保状态清理
            setVisible(false);
          },
          escapeToClose: true,
          defaultPlacement: "bottom",
          alignment: "center",
          style: { 
            width: "min(320px, 90vw)",
            maxHeight: "70vh",
          },
          className: `${this.pluginName}-manager-popup`,
        },
        React.createElement(
          "div",
          {
            style: {
              width: "min(320px, 90vw)",
              maxHeight: "70vh",
              backgroundColor: "var(--orca-bg-primary, var(--orca-color-bg-1))",
              borderRadius: "var(--orca-radius-md)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              border: "1px solid var(--orca-border-color, var(--orca-color-border))",
              boxShadow: "var(--orca-shadow-popup)",
            },
          },
          // 顶部容器（参考插件的设计）
          React.createElement(
            "div",
            {
              style: {
              padding: "8px 12px",
              borderBottom: "1px solid var(--orca-border-color, var(--orca-color-border))",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              userSelect: "none",
              backgroundColor: "var(--orca-bg-primary, var(--orca-color-bg-1))",
              },
            },
            // CSS/JS 标签切换
            React.createElement(
              "div",
              {
                style: {
                  display: "flex",
                  position: "relative",
                  padding: "0 6px",
                  borderRadius: "6px",
                  backgroundColor: "var(--orca-bg-secondary, var(--orca-color-bg-2))",
                },
              },
              React.createElement(
                "input",
                {
                  type: "radio",
                  id: `${this.pluginName}-radio-css`,
                  name: `${this.pluginName}-tabs`,
                  checked: snippetType === "css",
                  onChange: () => setSnippetType("css"),
                  style: { display: "none" },
                }
              ),
              React.createElement(
                "label",
                {
                  htmlFor: `${this.pluginName}-radio-css`,
                  style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "30px",
                    width: "60px",
                    cursor: "pointer",
                    color: snippetType === "css" ? "var(--orca-primary-color, var(--orca-color-primary-5))" : "var(--orca-text-secondary, var(--orca-color-text-2))",
                    fontWeight: snippetType === "css" ? 600 : 400,
                    transition: "all 0.2s",
                    zIndex: 2,
                  },
                },
                React.createElement("span", null, "CSS"),
                React.createElement(
                  "span",
                  {
                    style: {
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "0.8em",
                      minWidth: "1.5em",
                      height: "1.25em",
                      marginLeft: "0.4em",
                      borderRadius: "4px",
                      backgroundColor: snippetType === "css" 
                        ? "var(--orca-primary-color, var(--orca-color-primary-5))"
                        : "transparent",
                      color: snippetType === "css" 
                        ? "#fff" 
                        : "var(--orca-text-secondary, var(--orca-color-text-2))",
                      padding: "0 6px",
                      transition: "all 0.15s",
                    },
                  },
                  cssCount > 99 ? "99+" : cssCount.toString()
                )
              ),
              React.createElement(
                "input",
                {
                  type: "radio",
                  id: `${this.pluginName}-radio-js`,
                  name: `${this.pluginName}-tabs`,
                  checked: snippetType === "js",
                  onChange: () => setSnippetType("js"),
                  style: { display: "none" },
                }
              ),
              React.createElement(
                "label",
                {
                  htmlFor: `${this.pluginName}-radio-js`,
                  style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "30px",
                    width: "60px",
                    cursor: "pointer",
                    color: snippetType === "js" ? "var(--orca-primary-color, var(--orca-color-primary-5))" : "var(--orca-text-secondary, var(--orca-color-text-2))",
                    fontWeight: snippetType === "js" ? 600 : 400,
                    transition: "all 0.2s",
                    zIndex: 2,
                  },
                },
                React.createElement("span", { style: { paddingLeft: "0.2em" } }, "JS"),
                React.createElement(
                  "span",
                  {
                    style: {
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "0.8em",
                      minWidth: "1.5em",
                      height: "1.25em",
                      marginLeft: "0.4em",
                      borderRadius: "4px",
                      backgroundColor: snippetType === "js" 
                        ? "var(--orca-primary-color, var(--orca-color-primary-5))"
                        : "transparent",
                      color: snippetType === "js" 
                        ? "#fff" 
                        : "var(--orca-text-secondary, var(--orca-color-text-2))",
                      padding: "0 6px",
                      transition: "all 0.15s",
                    },
                  },
                  jsCount > 99 ? "99+" : jsCount.toString()
                )
              ),
              // 滑动指示器
              React.createElement(
                "span",
                {
                  style: {
                    position: "absolute",
                    top: "4px",
                    height: "22px",
                    width: "60px",
                    backgroundColor: "var(--orca-bg-primary, var(--orca-color-bg-1))",
                    borderRadius: "4px",
                    zIndex: 1,
                    transition: "transform 0.25s ease-out",
                    transform: snippetType === "js" ? "translateX(60px)" : "translateX(0)",
                  },
                }
              )
            ),
            React.createElement("span", { style: { flex: 1 } }),
            // 更多操作菜单按钮
            React.createElement(
              "div",
              { ref: moreMenuButtonRef as any },
              React.createElement(Button, {
                variant: "plain",
                onClick: (e: any) => {
                  e?.stopPropagation();
                  e?.preventDefault();
                  setShowMoreMenu(!showMoreMenu);
                },
                className: "block__icon block__icon--show fn__flex-center ariaLabel",
                style: { margin: "0 1px" },
                title: "更多操作",
              }, React.createElement("i", { className: "ti ti-dots", style: { pointerEvents: "none" } })),
            ),
            showMoreMenu ? React.createElement(
              Popup,
              {
                refElement: moreMenuButtonRef as any,
                visible: showMoreMenu,
                onClose: () => setShowMoreMenu(false),
                defaultPlacement: "bottom",
                alignment: "right",
                escapeToClose: true,
              },
              React.createElement(
                Menu,
                null,
                React.createElement(MenuText, {
                  title: "导出全部",
                  preIcon: "ti ti-download",
                  onClick: () => {
                    setShowMoreMenu(false);
                    try {
                      this.exportSnippets();
                      orca.notify("success", "已导出全部代码片段");
                    } catch (error: any) {
                      orca.notify("error", `导出代码片段失败：${error.message}`);
                    }
                  },
                }),
                React.createElement(MenuText, {
                  title: "导入片段",
                  preIcon: "ti ti-upload",
                  onClick: () => {
                    setShowMoreMenu(false);
                    importInputRef.current?.click();
                  },
                }),
                React.createElement(MenuText, {
                  title: "重载界面",
                  preIcon: "ti ti-refresh",
                  onClick: () => {
                    setShowMoreMenu(false);
                    location.reload();
                  },
                }),
              )
            ) : null,
            React.createElement("input", {
              ref: importInputRef,
              type: "file",
              accept: ".json,application/json",
              style: { display: "none" },
              onChange: async (e: any) => {
                const file = e.target.files?.[0];
                if (!file) return;
                
                try {
                  const result = await this.importSnippets(file);
                  if (result.success > 0) {
                    setSnippets(this.getAllSnippets());
                    window.dispatchEvent(new CustomEvent(`${this.pluginName}-refresh`));
                    const message = result.failed > 0
                      ? `已导入 ${result.success} 条，${result.failed} 条失败`
                      : `已导入 ${result.success} 条代码片段`;
                    orca.notify("success", message);
                    if (result.errors.length > 0) {
                      console.error("Import errors:", result.errors);
                    }
                  } else {
                    orca.notify("error", `导入失败：${result.errors.join("；")}`);
                  }
                } catch (error: any) {
                  orca.notify("error", `导入代码片段失败：${error.message}`);
                }
                
                // 重置 input 值，允许重复选择同一个文件
                e.target.value = "";
              },
            }),
            // 搜索按钮
            React.createElement(Button, {
              variant: "plain",
              onClick: () => setShowSearch(!showSearch),
              className: "block__icon block__icon--show fn__flex-center ariaLabel",
              style: { margin: "0 1px" },
              title: "搜索",
            }, React.createElement("i", { className: "ti ti-search", style: { pointerEvents: "none" } })),
            // 添加按钮
            React.createElement(Button, {
              variant: "plain",
              onClick: (e: any) => {
                e?.stopPropagation();
                e?.preventDefault();
                handleClose();
                setTimeout(() => {
                  openAddDialog(() => {});
                }, 100);
              },
              className: "block__icon block__icon--show fn__flex-center ariaLabel",
              style: { margin: "0 1px" },
              title: "添加代码片段",
            }, React.createElement("i", { className: "ti ti-plus", style: { pointerEvents: "none" } })),
            // 关闭按钮
            React.createElement(Button, {
              variant: "plain",
              onClick: (e: any) => {
                e?.stopPropagation();
                e?.preventDefault();
                handleClose();
              },
              className: "block__icon block__icon--show fn__flex-center ariaLabel",
              style: { margin: "0 1px" },
            }, React.createElement("i", { className: "ti ti-x", style: { pointerEvents: "none" } }))
          ),
          React.createElement(
            "div",
            {
              style: {
                padding: "8px 12px",
                borderBottom: "1px solid var(--orca-border-color, var(--orca-color-border))",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                backgroundColor: currentTypeEnabled
                  ? "var(--orca-bg-primary, var(--orca-color-bg-1))"
                  : "var(--orca-bg-secondary, var(--orca-color-bg-2))",
              },
            },
            React.createElement(
              "span",
              {
                style: {
                  flex: 1,
                  fontSize: "13px",
                  color: "var(--orca-text-primary, var(--orca-color-text-1))",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                },
              },
              `${snippetType.toUpperCase()} 总开关`
            ),
            React.createElement(
              "span",
              {
                style: {
                  fontSize: "12px",
                  color: "var(--orca-text-secondary, var(--orca-color-text-2))",
                },
              },
              currentTypeEnabled ? "已开启" : "已关闭"
            ),
            React.createElement(Switch, {
              on: currentTypeEnabled,
              onChange: (on: boolean) => handleTypeToggle(snippetType, on),
            })
          ),
          // 搜索输入框
          showSearch ? React.createElement(
            "div",
            {
            style: {
              padding: "8px 16px",
              borderBottom: "1px solid var(--orca-border-color, var(--orca-color-border))",
            },
          },
            React.createElement(Input, {
              placeholder: "搜索代码片段...",
              value: searchQuery,
              onChange: (e: any) => setSearchQuery(e.target.value),
              style: { width: "100%" },
            })
          ) : null,
          // 内容区域（简洁的列表样式）
          React.createElement(
            "div",
            {
              style: {
                flex: 1,
                overflow: "auto",
                padding: "4px 0",
                backgroundColor: "var(--orca-bg-primary, var(--orca-color-bg-1))",
              },
            },
            filteredSnippets.length === 0
              ? React.createElement(
                  "div",
                  {
                    style: {
                      textAlign: "center",
                      padding: "20px",
                      color: "var(--orca-text-secondary, var(--orca-color-text-2))",
                    },
                  },
                  snippetType === "css" 
                    ? '还没有 CSS 片段。点击「+」添加。'
                    : '还没有 JavaScript 片段。点击「+」添加。'
                )
              : React.createElement(
                  "div",
                  null,
                  filteredSnippets.map((snippet: Snippet) => {
                    // 使用单独的组件来处理 hover 状态
                      const SnippetItemComponent = () => {
                      const [hovered, setHovered] = React.useState(false);
                      return React.createElement(
                        "div",
                        {
                          onMouseEnter: () => setHovered(true),
                          onMouseLeave: () => setHovered(false),
                          onClick: (e: any) => {
                            // 如果点击的是按钮，不处理（让按钮自己的 onClick 处理）
                            if ((e.target as HTMLElement).closest('button')) {
                              return;
                            }
                            // 点击项本身也打开编辑对话框
                            e?.stopPropagation();
                            e?.preventDefault();
                            handleClose();
                            setTimeout(() => {
                              openEditDialog(snippet, () => {});
                            }, 100);
                          },
                          style: {
                            padding: "0 10px",
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            cursor: "pointer",
                            transition: "background-color 0.2s",
                            backgroundColor: hovered 
                              ? "var(--orca-bg-hover, var(--orca-color-bg-2))" 
                              : "transparent",
                          },
                        },
                        // 代码片段名称
                        React.createElement(
                          "span",
                          {
                            style: {
                              flex: 1,
                              fontSize: "13px",
                              color: "var(--orca-text-primary, var(--orca-color-text-1))",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              padding: "6px 0",
                            },
                            title: snippet.name || snippet.content.slice(0, 200),
                          },
                          snippet.name || snippet.content.slice(0, 50) + (snippet.content.length > 50 ? "..." : "")
                        ),
                        React.createElement("span", { style: { flex: 0 } }),
                        // 操作按钮（hover 时显示）
                        hovered ? React.createElement(
                          "div",
                          { style: { display: "flex", gap: "4px", alignItems: "center" } },
                          React.createElement(Button, {
                            variant: "plain",
                            onClick: (e: any) => {
                              e?.stopPropagation();
                              e?.preventDefault();
                              handleClose();
                              setTimeout(() => {
                                openEditDialog(snippet, () => {});
                              }, 100);
                            },
                            style: { padding: "4px", minWidth: "auto" },
                            title: "编辑",
                          }, React.createElement("i", { className: "ti ti-edit", style: { fontSize: "14px" } })),
                          React.createElement(Button, {
                            variant: "plain",
                            onClick: (e: any) => {
                              e?.stopPropagation();
                              e?.preventDefault();
                              try {
                                this.exportSnippet(snippet.id);
                                orca.notify("success", "已导出这条代码片段");
                              } catch (error: any) {
                                orca.notify("error", `导出这条代码片段失败：${error.message}`);
                              }
                            },
                            style: { padding: "4px", minWidth: "auto" },
                            title: "导出",
                          }, React.createElement("i", { className: "ti ti-download", style: { fontSize: "14px" } })),
                          React.createElement(Button, {
                            variant: "plain",
                            onClick: async (e: any) => {
                              e?.stopPropagation();
                              e?.preventDefault();
                              await handleDelete(snippet.id);
                            },
                            style: { padding: "4px", minWidth: "auto" },
                            title: "删除",
                          }, React.createElement("i", { className: "ti ti-trash", style: { fontSize: "14px" } }))
                        ) : null,
                        React.createElement("span", { style: { width: "8px" } }),
                        // 启用开关
                        React.createElement(Switch, {
                          on: snippet.enabled,
                          onChange: () => {
                            handleToggle(snippet.id);
                          },
                        })
                      );
                    };
                    return React.createElement(SnippetItemComponent, { key: snippet.id });
                  })
                )
          )
        )
      );
    };

    // 获取顶栏按钮作为 Popup 的锚点
    // 尝试多种选择器来找到按钮
    let headbarButton: HTMLElement | null = null;
    
    // 方法1: 通过 data-plugin-button 属性
    headbarButton = document.querySelector(`button[data-plugin-button="${this.pluginName}.headbarButton"]`) as HTMLElement;
    
    // 方法2: 通过查找包含 ti-code 图标的按钮
    if (!headbarButton) {
      const buttons = document.querySelectorAll('button, [role="button"]');
      for (const btn of Array.from(buttons)) {
        const icon = btn.querySelector('i.ti-code, i[class*="code"]');
        if (icon) {
          headbarButton = btn as HTMLElement;
          break;
        }
      }
    }
    
    // 方法3: 创建临时锚点
    if (!headbarButton) {
      // 创建一个临时元素作为锚点，放在右上角
      const tempAnchor = document.createElement('div');
      tempAnchor.id = `${this.pluginName}-temp-anchor`;
      tempAnchor.style.position = 'fixed';
      tempAnchor.style.top = 'var(--orca-height-headbar, 40px)';
      tempAnchor.style.right = '20px';
      tempAnchor.style.width = '1px';
      tempAnchor.style.height = '1px';
      tempAnchor.style.zIndex = '-1';
      document.body.appendChild(tempAnchor);
      headbarButton = tempAnchor;
    }
    
    // 创建或更新按钮引用
    if (!this.managerButtonRef) {
      const buttonRef = React.createRef<HTMLElement>();
      (buttonRef as any).current = headbarButton;
      this.managerButtonRef = buttonRef;
    } else {
      (this.managerButtonRef as any).current = headbarButton;
    }

    // 创建临时容器用于渲染
    const container = document.createElement("div");
    container.id = `${this.pluginName}-manager-container`;
    document.body.appendChild(container);

    const root = window.createRoot(container);
    
    // 创建或获取编辑对话框的独立容器（如果已存在则先清理）
    let editContainer = document.getElementById(`${this.pluginName}-edit-container`);
    if (editContainer) {
      // 清理旧的容器和 root
      const oldRoot = (editContainer as any)._reactRootContainer;
      if (oldRoot) {
        try {
          oldRoot.unmount();
        } catch (e) {
          // Error unmounting old edit root
        }
      }
      editContainer.remove();
    }
    
    editContainer = document.createElement("div");
    editContainer.id = `${this.pluginName}-edit-container`;
    document.body.appendChild(editContainer);
    
    const editRoot = window.createRoot(editContainer);
    (editContainer as any)._reactRootContainer = editRoot;

    // 延迟渲染以确保按钮已经在DOM中
    const renderMenu = () => {
      // 重新查找按钮（可能在DOM更新后才存在）
      let foundButton = headbarButton;
      
      if (!foundButton || !(foundButton as HTMLElement).isConnected) {
        foundButton = document.querySelector(`button[data-plugin-button="${this.pluginName}.headbarButton"]`) as HTMLElement;
      }
      
      if (!foundButton) {
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const btn of Array.from(buttons)) {
          const icon = btn.querySelector('i.ti-code, i[class*="code"]');
          if (icon) {
            foundButton = btn as HTMLElement;
            break;
          }
        }
      }
      
      // 如果还是找不到，创建临时锚点
      if (!foundButton) {
        foundButton = document.createElement('div');
        foundButton.id = `${this.pluginName}-temp-anchor`;
        foundButton.style.position = 'fixed';
        foundButton.style.top = 'var(--orca-height-headbar, 40px)';
        foundButton.style.right = '20px';
        foundButton.style.width = '1px';
        foundButton.style.height = '1px';
        foundButton.style.zIndex = '-1';
        document.body.appendChild(foundButton);
      }
      
      // 更新引用
      if (foundButton && this.managerButtonRef) {
        (this.managerButtonRef as any).current = foundButton;
      }
      
      this.managerPopupVisible = true;
      
      try {
        root.render(React.createElement(ManagerMenu));
      } catch (error: any) {
        orca.notify("error", `打开代码片段管理器失败：${error?.message || String(error)}`, { title: "错误" });
      }
    };
    
    // 立即尝试渲染，如果按钮已存在
    renderMenu();
    
    // 也延迟一下，以防DOM还没更新
    setTimeout(renderMenu, 10);

    // 创建编辑对话框组件
    const EditDialog = () => {
      const [snippets, setSnippets] = React.useState<Snippet[]>(
        this.getAllSnippets()
      );
      const [editingSnippet, setEditingSnippet] = React.useState<Snippet | null>(null);
      const [isAdding, setIsAdding] = React.useState(false);
      const [formData, setFormData] = React.useState({
        name: "",
        content: "",
        type: "css" as "css" | "js",
        enabled: true,
      });
      const [editVisible, setEditVisible] = React.useState(false);
      const editorRef = React.useRef<EditorView | null>(null);
      const containerRef = React.useRef<HTMLDivElement | null>(null);

      // 创建 CodeMirror 编辑器扩展
      const createEditorExtensions = (language: "css" | "js") => {
        const languageSupport = language === "js" ? javascript() : css();
        const theme = orca.state.themeMode === "dark" ? oneDark : undefined;
        
        return [
          lineNumbers(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          bracketMatching(),
          closeBrackets(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          indentUnit.of("  "),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
          languageSupport,
          ...(theme ? [theme] : []),
        ];
      };

      // 创建 CodeMirror 编辑器
      const createCodeMirrorEditor = (container: HTMLElement, content: string, language: "css" | "js") => {
        const state = EditorState.create({
          doc: content,
          extensions: createEditorExtensions(language),
        });

        const view = new EditorView({
          state,
          parent: container,
        });

        editorRef.current = view;
        return view;
      };

      // 监听打开编辑对话框的事件（使用 useRef 避免重复注册）
      const eventHandledRef = React.useRef(false);
      
      React.useEffect(() => {
        // 防止重复注册事件监听器
        if (eventHandledRef.current) {
          return;
        }
        eventHandledRef.current = true;
        
        const handleOpenEdit = (e: CustomEvent) => {
          // 如果已经有对话框打开，先关闭
          if (editVisible) {
            setEditVisible(false);
            setTimeout(() => {
              if (e.detail.type === "add") {
                setIsAdding(true);
                setEditVisible(true);
                setFormData({ 
                  name: "", 
                  content: "", 
                  type: e.detail.defaultType || "css", 
                  enabled: true 
                });
              } else if (e.detail.type === "edit") {
                setEditingSnippet(e.detail.snippet);
                setEditVisible(true);
                setFormData({
                  name: e.detail.snippet.name,
                  content: e.detail.snippet.content,
                  type: e.detail.snippet.type,
                  enabled: e.detail.snippet.enabled,
                });
              }
            }, 100);
          } else {
            if (e.detail.type === "add") {
              setIsAdding(true);
              setEditVisible(true);
              setFormData({ 
                name: "", 
                content: "", 
                type: e.detail.defaultType || "css", 
                enabled: true 
              });
            } else if (e.detail.type === "edit") {
              setEditingSnippet(e.detail.snippet);
              setEditVisible(true);
              setFormData({
                name: e.detail.snippet.name,
                content: e.detail.snippet.content,
                type: e.detail.snippet.type,
                enabled: e.detail.snippet.enabled,
              });
            }
          }
        };

        const handleCloseEdit = () => {
          setIsAdding(false);
          setEditingSnippet(null);
          setEditVisible(false);
          setFormData({ name: "", content: "", type: "css", enabled: true });
        };

        window.addEventListener(`${this.pluginName}-open-edit` as any, handleOpenEdit);
        window.addEventListener(`${this.pluginName}-close-edit` as any, handleCloseEdit);

        return () => {
          eventHandledRef.current = false;
          window.removeEventListener(`${this.pluginName}-open-edit` as any, handleOpenEdit);
          window.removeEventListener(`${this.pluginName}-close-edit` as any, handleCloseEdit);
        };
      }, []);

      // 初始化 CodeMirror 编辑器
      React.useEffect(() => {
        if (!containerRef.current || !editVisible) return;
        
        // 销毁旧的编辑器
        if (editorRef.current) {
          editorRef.current.destroy();
          editorRef.current = null;
        }
        
        // 创建新的编辑器
        createCodeMirrorEditor(containerRef.current, formData.content, formData.type);
        
        return () => {
          if (editorRef.current) {
            editorRef.current.destroy();
            editorRef.current = null;
          }
        };
      }, [editVisible, formData.type]);

      const handleAdd = async () => {
        const content = editorRef.current ? editorRef.current.state.doc.toString() : formData.content;
        if (!formData.name.trim() || !content.trim()) {
          orca.notify("error", "名称和内容不能为空");
          return;
        }

        try {
          await this.addSnippet({ ...formData, content });
          orca.notify("success", "代码片段已添加");
          setIsAdding(false);
          setEditVisible(false);
          setFormData({ name: "", content: "", type: "css", enabled: true });
          window.dispatchEvent(new CustomEvent(`${this.pluginName}-refresh`));
        } catch (error: any) {
          orca.notify("error", `添加代码片段失败：${error.message}`);
        }
      };

      const handleEdit = async () => {
        if (!editingSnippet) return;
        
        const content = editorRef.current ? editorRef.current.state.doc.toString() : formData.content;
        if (!formData.name.trim() || !content.trim()) {
          orca.notify("error", "名称和内容不能为空");
          return;
        }

        try {
          await this.updateSnippet(editingSnippet.id, { ...formData, content });
          orca.notify("success", "代码片段已更新");
          setEditingSnippet(null);
          setEditVisible(false);
          setFormData({ name: "", content: "", type: "css", enabled: true });
          window.dispatchEvent(new CustomEvent(`${this.pluginName}-refresh`));
        } catch (error: any) {
          orca.notify("error", `更新代码片段失败：${error.message}`);
        }
      };

      const closeEditDialog = () => {
        setIsAdding(false);
        setEditingSnippet(null);
        setEditVisible(false);
        setFormData({ name: "", content: "", type: "css", enabled: true });
      };

      return React.createElement(
        ModalOverlay,
        {
          visible: editVisible,
          canClose: true,
          onClose: closeEditDialog,
          style: { zIndex: 10001 },
        },
        React.createElement(
          "div",
          {
            style: {
              width: "85vw",
              maxWidth: "800px",
              height: "80vh",
              maxHeight: "600px",
              backgroundColor: "var(--orca-bg-primary, var(--orca-color-bg-1))",
              borderRadius: "var(--orca-radius-md)",
              padding: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              boxShadow: "var(--orca-shadow-popup)",
              border: "1px solid var(--orca-border-color, var(--orca-color-border))",
              position: "relative",
              overflow: "hidden",
              boxSizing: "border-box",
            },
          },
          // 关闭按钮
          React.createElement(
            "div",
            {
              style: {
                display: "flex",
                justifyContent: "flex-end",
                alignItems: "center",
                marginBottom: "0px",
                marginTop: "-4px",
              },
            },
            React.createElement(Button, {
              variant: "plain",
              onClick: closeEditDialog,
              style: { padding: "4px" },
            }, React.createElement("i", { className: "ti ti-x" }))
          ),
          React.createElement(Input, {
            placeholder: "片段名称",
            value: formData.name,
            onChange: (e: any) =>
              setFormData({ ...formData, name: e.target.value }),
          }),
          // 类型选择器（只在添加时显示）
          isAdding ? React.createElement(
            "div",
            {
              style: {
                display: "flex",
                flexDirection: "column",
                gap: "6px",
              },
            },
            React.createElement(
              "label",
              {
                style: {
                  fontSize: "13px",
                  fontWeight: 500,
                  color: "var(--orca-text-primary)",
                },
              },
              "类型"
            ),
            React.createElement(Segmented, {
              selected: formData.type,
              options: [
                {
                  value: "css",
                  label: "CSS",
                  jsx: React.createElement("div", {
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    },
                  }, React.createElement("i", {
                    className: "ti ti-brand-css3",
                    style: { fontSize: "16px" },
                  }), "CSS"),
                },
                {
                  value: "js",
                  label: "JavaScript",
                  jsx: React.createElement("div", {
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    },
                  }, React.createElement("i", {
                    className: "ti ti-brand-javascript",
                    style: { fontSize: "16px" },
                  }), "JavaScript"),
                },
              ],
              onChange: (value: string) =>
                setFormData({
                  ...formData,
                  type: value as "css" | "js",
                }),
            })
          ) : null,
          // 代码编辑器区域
          React.createElement(
            "div",
            {
              style: {
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                flex: 1,
                minHeight: "200px",
                overflow: "hidden",
              },
            },
            React.createElement("div", {
              ref: containerRef,
              style: {
                width: "100%",
                flex: 1,
                border: "1px solid var(--orca-border-color, var(--orca-color-border))",
                borderRadius: "4px",
                overflow: "hidden",
                minHeight: "150px",
                fontSize: "13px",
              },
            })
          ),
          React.createElement(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: "8px",
                marginTop: "-4px",
              },
            },
            React.createElement(Switch, {
              on: formData.enabled,
              onChange: (on: boolean) => {
                setFormData({ ...formData, enabled: on });
              },
            }),
            React.createElement("span", null, "立即启用")
          ),
          React.createElement(
            "div",
            {
              style: {
                display: "flex",
                gap: "8px",
                justifyContent: "flex-end",
                marginTop: "auto",
                paddingTop: "0px",
                flexShrink: 0,
              },
            },
            React.createElement(Button, {
              variant: "outline",
              onClick: closeEditDialog,
            }, "取消"),
            React.createElement(Button, {
              variant: "solid",
              onClick: isAdding ? handleAdd : handleEdit,
            }, isAdding ? "添加" : "更新")
          )
        )
      );
    };

    editRoot.render(React.createElement(EditDialog));
  }
}
