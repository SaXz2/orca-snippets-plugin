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

/**
 * 代码片段管理器
 * 负责代码片段的存储、加载、注入和管理界面
 */
export class SnippetManager {
  private pluginName: string;
  private snippets: Map<string, Snippet> = new Map();
  private injectedElements: Map<string, HTMLElement> = new Map();

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
      console.error(`[${this.pluginName}] Failed to load snippets:`, error);
    }
  }

  /**
   * 保存所有代码片段到存储
   */
  private async saveSnippets() {
    const snippetsArray = Array.from(this.snippets.values());
    await orca.plugins.setData(
      this.pluginName,
      "snippets",
      JSON.stringify(snippetsArray)
    );
  }

  /**
   * 加载所有启用的代码片段
   */
  async loadAllEnabled() {
    for (const snippet of this.snippets.values()) {
      if (snippet.enabled) {
        this.injectSnippet(snippet);
      }
    }
  }

  /**
   * 清理所有注入的代码片段
   */
  cleanup() {
    for (const element of this.injectedElements.values()) {
      element.remove();
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
        error: "Code is empty",
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
        error: error.message || "Potential syntax issue",
      };
    }
  }

  /**
   * 注入代码片段到页面
   */
  private injectSnippet(snippet: Snippet) {
    // 移除旧的元素（如果存在）
    this.removeSnippet(snippet.id);

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
        console.warn(
          `[${this.pluginName}] JavaScript validation warning for "${snippet.name}": ${validation.error}. Will attempt to inject anyway.`
        );
      }

      // 注入 JavaScript
      try {
        // 检查代码是否需要等待 DOM 就绪
        const needsDOMReady = this.checkIfNeedsDOMReady(snippet.content);
        
        // 使用 Function 构造函数执行代码（利用 unsafe-eval 权限）
        const executeCode = () => {
          try {
            // 创建一个函数来执行代码片段
            const func = new Function(snippet.content);
            func();
          } catch (error: any) {
            console.error(`[${this.pluginName}] Error executing snippet "${snippet.name}":`, error);
            orca.notify(
              "error",
              `JavaScript error in "${snippet.name}": ${error.message}`,
              { title: "Code Snippet Error" }
            );
          }
        };
        
        if (needsDOMReady) {
          // 需要等待 DOM 就绪
          if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", executeCode);
          } else if (document.readyState === "interactive") {
            // DOM 已解析但可能还未完全渲染，延迟执行
            setTimeout(executeCode, 100);
          } else {
            // DOM 已完全加载
            executeCode();
          }
        } else {
          // 不需要等待 DOM，立即执行
          executeCode();
        }
        
        // 创建一个占位 script 元素用于追踪
        const scriptElement = document.createElement("script");
        scriptElement.id = elementId;
        scriptElement.type = "text/javascript";
        scriptElement.textContent = `// Code snippet: ${snippet.name}`;
        document.head.appendChild(scriptElement);
        this.injectedElements.set(snippet.id, scriptElement);
        
        console.log(`[${this.pluginName}] Injected JavaScript snippet: ${snippet.name} (ID: ${elementId})`);
      } catch (error: any) {
        orca.notify(
          "error",
          `Failed to inject JavaScript "${snippet.name}": ${error.message}`,
          { title: "Code Snippet Error" }
        );
        console.error(`[${this.pluginName}] Failed to inject JavaScript:`, error);
      }
    }
  }

  /**
   * 移除代码片段
   */
  private removeSnippet(snippetId: string) {
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
      throw new Error(`Snippet ${snippetId} not found`);
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
      throw new Error(`Snippet ${snippetId} not found`);
    }

    return await this.updateSnippet(snippetId, {
      enabled: !snippet.enabled,
    });
  }

  /**
   * 获取所有代码片段
   */
  getAllSnippets(): Snippet[] {
    return Array.from(this.snippets.values());
  }

  /**
   * 获取代码片段
   */
  getSnippet(snippetId: string): Snippet | undefined {
    return this.snippets.get(snippetId);
  }

  // 管理弹出菜单的状态
  private managerPopupVisible = false;
  private managerButtonRef: React.RefObject<HTMLElement> | null = null;

  /**
   * 打开代码片段管理器
   */
  async openManager() {
    console.log(`[${this.pluginName}] openManager called`);
    
    const React = window.React;
    if (!React) {
      console.error(`[${this.pluginName}] React is not available`);
      return;
    }
    
    const Button = orca.components.Button;
    const Input = orca.components.Input;
    const Select = orca.components.Select;
    const Segmented = orca.components.Segmented;
    const Switch = orca.components.Switch;
    const Popup = orca.components.Popup;
    const ModalOverlay = orca.components.ModalOverlay;
    const ConfirmBox = orca.components.ConfirmBox;
    const Menu = orca.components.Menu;
    const MenuText = orca.components.MenuText;

    console.log(`[${this.pluginName}] Components loaded, Popup:`, !!Popup);

    // 如果已经有打开的菜单，先关闭
    if (this.managerPopupVisible) {
      console.log(`[${this.pluginName}] Menu already visible, closing`);
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
            console.warn(`[${this.pluginName}] Error unmounting edit root:`, e);
          }
        }
        editContainer.remove();
      }
      return;
    }
    
    // 清理可能存在的旧编辑对话框容器（如果管理器未打开但编辑对话框还在）
    const existingEditContainer = document.getElementById(`${this.pluginName}-edit-container`);
    if (existingEditContainer) {
      console.log(`[${this.pluginName}] Cleaning up existing edit container`);
      const existingEditRoot = (existingEditContainer as any)._reactRootContainer;
      if (existingEditRoot) {
        try {
          existingEditRoot.unmount();
        } catch (e) {
          console.warn(`[${this.pluginName}] Error unmounting existing edit root:`, e);
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
      
      // 筛选代码片段
      const filteredSnippets = snippets.filter((snippet: Snippet) => {
        const typeMatch = snippet.type === snippetType;
        const searchMatch = !searchQuery || 
          snippet.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          snippet.content.toLowerCase().includes(searchQuery.toLowerCase());
        return typeMatch && searchMatch;
      });

      const handleDelete = async (snippetId: string, close: () => void) => {
        try {
          await this.deleteSnippet(snippetId);
          orca.notify("success", "Snippet deleted successfully");
          setSnippets(this.getAllSnippets());
        } catch (error: any) {
          orca.notify("error", `Failed to delete snippet: ${error.message}`);
        }
      };

      const handleToggle = async (snippetId: string) => {
        try {
          await this.toggleSnippet(snippetId);
          setSnippets(this.getAllSnippets());
        } catch (error: any) {
          orca.notify("error", `Failed to toggle snippet: ${error.message}`);
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
        console.log(`[${this.pluginName}] Closing manager menu`);
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
                  console.warn(`[${this.pluginName}] Error unmounting root:`, e);
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
        console.log(`[${this.pluginName}] Popup not shown - button:`, !!currentButton, `visible:`, visible);
        return null;
      }
      
      // 更新 ref
      buttonRef.current = currentButton;
      
      console.log(`[${this.pluginName}] Rendering Popup with button:`, currentButton);
      return React.createElement(
        Popup,
        {
          refElement: buttonRef as any,
          visible: visible,
          onClose: () => {
            console.log(`[${this.pluginName}] Popup onClose called`);
            handleClose();
          },
          onClosed: () => {
            console.log(`[${this.pluginName}] Popup onClosed called`);
            this.managerPopupVisible = false;
            // 确保状态清理
            setVisible(false);
          },
          escapeToClose: true,
          defaultPlacement: "bottom",
          alignment: "center",
          style: { 
            width: "min(400px, 90vw)",
            maxHeight: "80vh",
          },
          className: `${this.pluginName}-manager-popup`,
        },
        React.createElement(
          "div",
          {
            style: {
              width: "min(400px, 90vw)",
              maxHeight: "80vh",
              backgroundColor: "var(--orca-bg-primary, #fff)",
              borderRadius: "8px",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
            },
          },
          // 顶部容器（参考插件的设计）
          React.createElement(
            "div",
            {
              style: {
                padding: "10px 16px",
                borderBottom: "1px solid var(--orca-border-color, #e0e0e0)",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                userSelect: "none",
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
                  backgroundColor: "var(--orca-bg-secondary, #f5f5f5)",
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
                    color: snippetType === "css" ? "var(--orca-primary-color, #007bff)" : "var(--orca-text-secondary, #666)",
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
                        ? "var(--orca-primary-color, #007bff)"
                        : "var(--orca-bg-primary, #fff)",
                      color: snippetType === "css" 
                        ? "#fff" 
                        : "var(--orca-text-secondary, #666)",
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
                    color: snippetType === "js" ? "var(--orca-primary-color, #007bff)" : "var(--orca-text-secondary, #666)",
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
                        ? "var(--orca-primary-color, #007bff)"
                        : "var(--orca-bg-primary, #fff)",
                      color: snippetType === "js" 
                        ? "#fff" 
                        : "var(--orca-text-secondary, #666)",
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
                    backgroundColor: "var(--orca-bg-primary, #fff)",
                    borderRadius: "4px",
                    zIndex: 1,
                    transition: "transform 0.25s ease-out",
                    transform: snippetType === "css" ? "translateX(0)" : "translateX(100%)",
                  },
                }
              )
            ),
            React.createElement("span", { style: { flex: 1 } }),
            // 搜索按钮
            React.createElement(Button, {
              variant: "plain",
              onClick: () => setShowSearch(!showSearch),
              style: { padding: "4px" },
              title: "Search",
            }, React.createElement("i", { className: "ti ti-search" })),
            // 添加按钮
            React.createElement(Button, {
              variant: "plain",
              onClick: (e: any) => {
                e?.stopPropagation();
                e?.preventDefault();
                console.log(`[${this.pluginName}] Add button clicked`);
                handleClose();
                setTimeout(() => {
                  openAddDialog(() => {});
                }, 100);
              },
              style: { padding: "4px" },
              title: "Add Snippet",
            }, React.createElement("i", { className: "ti ti-plus" })),
            // 关闭按钮
            React.createElement(Button, {
              variant: "plain",
              onClick: (e: any) => {
                e?.stopPropagation();
                e?.preventDefault();
                console.log(`[${this.pluginName}] Close button clicked`);
                handleClose();
              },
              style: { padding: "4px" },
            }, React.createElement("i", { className: "ti ti-x" }))
          ),
          // 搜索输入框
          showSearch ? React.createElement(
            "div",
            {
              style: {
                padding: "8px 16px",
                borderBottom: "1px solid var(--orca-border-color, #e0e0e0)",
              },
            },
            React.createElement(Input, {
              placeholder: "Search snippets...",
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
                backgroundColor: "var(--orca-bg-primary, #fff)",
              },
            },
            filteredSnippets.length === 0
              ? React.createElement(
                  "div",
                  {
                    style: {
                      textAlign: "center",
                      padding: "40px",
                      color: "var(--orca-text-secondary, #666)",
                    },
                  },
                  snippetType === "css" 
                    ? 'No CSS snippets yet. Click "+" to add one.'
                    : 'No JavaScript snippets yet. Click "+" to add one.'
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
                            padding: "0 6px",
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            cursor: "pointer",
                            transition: "background-color 0.2s",
                            backgroundColor: hovered 
                              ? "var(--orca-bg-hover, rgba(0,0,0,0.05))" 
                              : "transparent",
                          },
                        },
                        // 代码片段名称
                        React.createElement(
                          "span",
                          {
                            style: {
                              flex: 1,
                              fontSize: "14px",
                              color: "var(--orca-text-primary, #000)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              padding: "8px 0",
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
                              console.log(`[${this.pluginName}] Edit button clicked for snippet:`, snippet.name);
                              handleClose();
                              setTimeout(() => {
                                openEditDialog(snippet, () => {});
                              }, 100);
                            },
                            style: { padding: "4px", minWidth: "auto" },
                            title: "Edit",
                          }, React.createElement("i", { className: "ti ti-edit", style: { fontSize: "14px" } })),
                          React.createElement(ConfirmBox, {
                            text: `Are you sure you want to delete "${snippet.name || 'this snippet'}"?`,
                            onConfirm: async (e: any, close: () => void) => {
                              e?.stopPropagation();
                              await handleDelete(snippet.id, close);
                              close();
                            },
                            children: (open: (e: any) => void) =>
                              React.createElement(
                                Button,
                                {
                                  variant: "plain",
                                  onClick: (e: any) => {
                                    e?.stopPropagation();
                                    e?.preventDefault();
                                    open(e);
                                  },
                                  style: { padding: "4px", minWidth: "auto" },
                                  title: "Delete",
                                },
                                React.createElement("i", { className: "ti ti-trash", style: { fontSize: "14px" } })
                              ),
                          })
                        ) : null,
                        React.createElement("span", { style: { width: "8px" } }),
                        // 启用开关
                        React.createElement(Switch, {
                          on: snippet.enabled,
                          onChange: (e: any) => {
                            e?.stopPropagation();
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
    
    console.log(`[${this.pluginName}] Looking for headbar button...`);
    
    // 方法1: 通过 data-plugin-button 属性
    headbarButton = document.querySelector(`button[data-plugin-button="${this.pluginName}.headbarButton"]`) as HTMLElement;
    console.log(`[${this.pluginName}] Method 1 result:`, !!headbarButton);
    
    // 方法2: 通过查找包含 ti-code 图标的按钮
    if (!headbarButton) {
      const buttons = document.querySelectorAll('button, [role="button"]');
      for (const btn of Array.from(buttons)) {
        const icon = btn.querySelector('i.ti-code, i[class*="code"]');
        if (icon) {
          headbarButton = btn as HTMLElement;
          console.log(`[${this.pluginName}] Found button by icon:`, btn);
          break;
        }
      }
    }
    
    // 方法3: 创建临时锚点
    if (!headbarButton) {
      console.warn(`[${this.pluginName}] Cannot find headbar button, creating temporary anchor`);
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
    
    console.log(`[${this.pluginName}] Using button element:`, headbarButton);
    
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
          console.warn(`[${this.pluginName}] Error unmounting old edit root:`, e);
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
        console.warn(`[${this.pluginName}] Cannot find button, creating temporary anchor`);
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
      
      console.log(`[${this.pluginName}] Rendering ManagerMenu...`);
      console.log(`[${this.pluginName}] Button element:`, foundButton);
      
      try {
        root.render(React.createElement(ManagerMenu));
        console.log(`[${this.pluginName}] ManagerMenu rendered successfully`);
      } catch (error: any) {
        console.error(`[${this.pluginName}] Error rendering ManagerMenu:`, error);
        orca.notify("error", `Failed to open manager: ${error?.message || String(error)}`, { title: "Error" });
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

      // 监听打开编辑对话框的事件（使用 useRef 避免重复注册）
      const eventHandledRef = React.useRef(false);
      
      React.useEffect(() => {
        // 防止重复注册事件监听器
        if (eventHandledRef.current) {
          return;
        }
        eventHandledRef.current = true;
        
        const handleOpenEdit = (e: CustomEvent) => {
          console.log(`[${this.pluginName}] EditDialog received open-edit event:`, e.detail);
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
          console.log(`[${this.pluginName}] EditDialog received close-edit event`);
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

      const handleAdd = async () => {
        if (!formData.name.trim() || !formData.content.trim()) {
          orca.notify("error", "Name and content are required");
          return;
        }

        try {
          await this.addSnippet(formData);
          orca.notify("success", "Snippet added successfully");
          setIsAdding(false);
          setEditVisible(false);
          setFormData({ name: "", content: "", type: "css", enabled: true });
          window.dispatchEvent(new CustomEvent(`${this.pluginName}-refresh`));
        } catch (error: any) {
          orca.notify("error", `Failed to add snippet: ${error.message}`);
        }
      };

      const handleEdit = async () => {
        if (!editingSnippet) return;

        if (!formData.name.trim() || !formData.content.trim()) {
          orca.notify("error", "Name and content are required");
          return;
        }

        try {
          await this.updateSnippet(editingSnippet.id, formData);
          orca.notify("success", "Snippet updated successfully");
          setEditingSnippet(null);
          setEditVisible(false);
          setFormData({ name: "", content: "", type: "css", enabled: true });
          window.dispatchEvent(new CustomEvent(`${this.pluginName}-refresh`));
        } catch (error: any) {
          orca.notify("error", `Failed to update snippet: ${error.message}`);
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
              maxWidth: "900px",
              height: "85vh",
              maxHeight: "700px",
              backgroundColor: "var(--orca-bg-primary, #fff)",
              borderRadius: "8px",
              padding: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
              position: "relative",
              overflow: "hidden",
              boxSizing: "border-box",
            },
          },
          // 标题栏（只在添加时显示，编辑时不显示标题）
          isAdding ? React.createElement(
            "div",
            {
              style: {
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "8px",
              },
            },
            React.createElement(
              "h3",
              { style: { margin: 0, fontSize: "18px", fontWeight: 600 } },
              "Add Snippet"
            ),
            React.createElement(Button, {
              variant: "plain",
              onClick: closeEditDialog,
              style: { padding: "4px" },
            }, React.createElement("i", { className: "ti ti-x" }))
          ) : React.createElement(
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
          // 标题输入框
          React.createElement(
            "label",
            {
              style: {
                fontSize: "13px",
                fontWeight: 500,
                color: "var(--orca-text-primary, #000)",
                marginBottom: "2px",
              },
            },
            "Title"
          ),
          React.createElement(Input, {
            placeholder: "Snippet name",
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
                  color: "var(--orca-text-primary, #000)",
                },
              },
              "Type"
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
                minHeight: "250px",
                overflow: "hidden",
              },
            },
            React.createElement(
              "label",
              {
                style: {
                  fontSize: "13px",
                  fontWeight: 500,
                  color: "var(--orca-text-primary, #000)",
                },
              },
              "Code"
            ),
            React.createElement("textarea", {
              value: formData.content,
              onChange: (e: any) =>
                setFormData({ ...formData, content: e.target.value }),
              placeholder: `Enter ${formData.type.toUpperCase()} code...`,
              style: {
                width: "100%",
                flex: 1,
                padding: "10px",
                fontFamily: "monospace",
                fontSize: "13px",
                border: "1px solid var(--orca-border-color, #e0e0e0)",
                borderRadius: "4px",
                resize: "none",
                backgroundColor: "var(--orca-bg-primary, #fff)",
                color: "var(--orca-text-primary, #000)",
                boxSizing: "border-box",
                overflow: "auto",
                minHeight: "180px",
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
              onChange: (on: boolean) =>
                setFormData({ ...formData, enabled: on }),
            }),
            React.createElement("span", null, "Enable immediately")
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
            }, "Cancel"),
            React.createElement(Button, {
              variant: "solid",
              onClick: isAdding ? handleAdd : handleEdit,
            }, isAdding ? "Add" : "Update")
          )
        )
      );
    };

    editRoot.render(React.createElement(EditDialog));
  }
}

