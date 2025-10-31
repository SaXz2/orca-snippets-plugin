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

  /**
   * 打开代码片段管理器
   */
  async openManager() {
    const React = window.React;
    const Button = orca.components.Button;
    const Input = orca.components.Input;
    const Select = orca.components.Select;
    const Segmented = orca.components.Segmented;
    const Switch = orca.components.Switch;
    const ModalOverlay = orca.components.ModalOverlay;
    const ConfirmBox = orca.components.ConfirmBox;

    const ManagerDialog = () => {
      const [snippets, setSnippets] = React.useState<Snippet[]>(
        this.getAllSnippets()
      );
      const [visible, setVisible] = React.useState(true);
      const [filterType, setFilterType] = React.useState<"all" | "css" | "js">("all");

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

      const handleDelete = async (snippetId: string) => {
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

      const openAddDialog = () => {
        window.dispatchEvent(new CustomEvent(`${this.pluginName}-open-edit`, {
          detail: { type: "add" }
        }));
      };

      const openEditDialog = (snippet: Snippet) => {
        window.dispatchEvent(new CustomEvent(`${this.pluginName}-open-edit`, {
          detail: { type: "edit", snippet }
        }));
      };

      return React.createElement(
        ModalOverlay,
        {
          visible: visible,
          canClose: true,
          onClose: () => setVisible(false),
          style: { zIndex: 10000 },
        },
        React.createElement(
          "div",
          {
            style: {
              width: "90vw",
              maxWidth: "1200px",
              height: "90vh",
              maxHeight: "800px",
              backgroundColor: "var(--orca-bg-primary, #fff)",
              borderRadius: "8px",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            },
          },
          // 头部
          React.createElement(
            "div",
            {
              style: {
                padding: "16px 24px",
                borderBottom: "1px solid var(--orca-border-color, #e0e0e0)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              },
            },
          React.createElement(
            "h2",
            { style: { margin: 0, fontSize: "20px", fontWeight: 600 } },
            "Code Snippets Manager"
          ),
          React.createElement(
            "div",
            { style: { display: "flex", gap: "8px", alignItems: "center" } },
            // 筛选按钮
            React.createElement(
              "div",
              { style: { display: "flex", gap: "4px", marginRight: "8px" } },
              React.createElement(Button, {
                variant: filterType === "all" ? "solid" : "outline",
                onClick: () => setFilterType("all"),
                style: { padding: "4px 12px", fontSize: "12px" },
              }, "All"),
              React.createElement(Button, {
                variant: filterType === "css" ? "solid" : "outline",
                onClick: () => setFilterType("css"),
                style: { padding: "4px 12px", fontSize: "12px" },
              }, React.createElement("i", { className: "ti ti-brand-css3", style: { marginRight: "4px" } }), "CSS"),
              React.createElement(Button, {
                variant: filterType === "js" ? "solid" : "outline",
                onClick: () => setFilterType("js"),
                style: { padding: "4px 12px", fontSize: "12px" },
              }, React.createElement("i", { className: "ti ti-brand-javascript", style: { marginRight: "4px" } }), "JS")
            ),
            React.createElement(Button, {
              variant: "outline",
              onClick: openAddDialog,
            }, "Add Snippet"),
            React.createElement(Button, {
              variant: "plain",
              onClick: () => setVisible(false),
            }, React.createElement("i", { className: "ti ti-x" }))
          )
          ),
          // 内容区域
          React.createElement(
            "div",
            {
              style: {
                flex: 1,
                overflow: "auto",
                padding: "24px",
              },
            },
            snippets.length === 0
              ? React.createElement(
                  "div",
                  {
                    style: {
                      textAlign: "center",
                      padding: "40px",
                      color: "var(--orca-text-secondary, #666)",
                    },
                  },
                  'No snippets yet. Click "Add Snippet" to create one.'
                )
              : React.createElement(
                  "div",
                  {
                    style: { display: "flex", flexDirection: "column", gap: "12px" },
                  },
                  snippets
                    .filter((snippet: Snippet) => 
                      filterType === "all" || snippet.type === filterType
                    )
                    .map((snippet: Snippet) =>
                    React.createElement(
                      "div",
                      {
                        key: snippet.id,
                        style: {
                          border: "1px solid var(--orca-border-color, #e0e0e0)",
                          borderLeft: `4px solid ${
                            snippet.type === "css"
                              ? "var(--orca-primary-color, #007bff)"
                              : "var(--orca-accent-color, #28a745)"
                          }`,
                          borderRadius: "6px",
                          padding: "16px",
                          backgroundColor: "var(--orca-bg-secondary, #f5f5f5)",
                        },
                      },
                      React.createElement(
                        "div",
                        {
                          style: {
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: "12px",
                          },
                        },
                        React.createElement(
                          "div",
                          {
                            style: {
                              display: "flex",
                              alignItems: "center",
                              gap: "12px",
                            },
                          },
                          React.createElement(
                            "div",
                            { style: { display: "flex", alignItems: "center", gap: "8px" } },
                            React.createElement("i", {
                              className: snippet.type === "css" ? "ti ti-brand-css3" : "ti ti-brand-javascript",
                              style: {
                                fontSize: "18px",
                                color: snippet.type === "css"
                                  ? "var(--orca-primary-color, #007bff)"
                                  : "var(--orca-accent-color, #28a745)",
                              },
                            }),
                            React.createElement(
                              "h3",
                              { style: { margin: 0, fontSize: "16px", flex: 1 } },
                              snippet.name
                            )
                          ),
                          React.createElement(
                            "span",
                            {
                              style: {
                                padding: "4px 10px",
                                borderRadius: "12px",
                                fontSize: "11px",
                                fontWeight: 600,
                                backgroundColor:
                                  snippet.type === "css"
                                    ? "var(--orca-primary-color, #007bff)"
                                    : "var(--orca-accent-color, #28a745)",
                                color: "#fff",
                                textTransform: "uppercase",
                                letterSpacing: "0.5px",
                              },
                            },
                            snippet.type.toUpperCase()
                          ),
                          React.createElement(Switch, {
                            on: snippet.enabled,
                            onChange: () => handleToggle(snippet.id),
                          })
                        ),
                        React.createElement(
                          "div",
                          { style: { display: "flex", gap: "8px" } },
                          React.createElement(Button, {
                            variant: "outline",
                            onClick: () => openEditDialog(snippet),
                          }, "Edit"),
                          React.createElement(ConfirmBox, {
                            text: `Are you sure you want to delete "${snippet.name}"?`,
                            onConfirm: (e: any, close: () => void) => {
                              handleDelete(snippet.id);
                              close();
                            },
                            children: (open: (e: any) => void) =>
                              React.createElement(
                                Button,
                                {
                                  variant: "dangerous",
                                  onClick: open,
                                },
                                "Delete"
                              ),
                          })
                        )
                      ),
                      React.createElement(
                        "div",
                        {
                          style: {
                            position: "relative",
                            marginTop: "12px",
                          },
                        },
                        React.createElement(
                          "div",
                          {
                            style: {
                              position: "absolute",
                              top: "8px",
                              right: "8px",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              fontSize: "10px",
                              backgroundColor: snippet.type === "css"
                                ? "rgba(0, 123, 255, 0.1)"
                                : "rgba(40, 167, 69, 0.1)",
                              color: snippet.type === "css"
                                ? "var(--orca-primary-color, #007bff)"
                                : "var(--orca-accent-color, #28a745)",
                              fontWeight: 600,
                            },
                          },
                          snippet.type.toUpperCase()
                        ),
                        React.createElement(
                          "pre",
                          {
                            style: {
                              margin: 0,
                              padding: "12px",
                              paddingTop: "28px",
                              backgroundColor: "var(--orca-bg-primary, #fff)",
                              borderRadius: "4px",
                              fontSize: "12px",
                              fontFamily: "monospace",
                              overflow: "auto",
                              maxHeight: "200px",
                              border: "1px solid var(--orca-border-color, #e0e0e0)",
                              borderLeft: `3px solid ${
                                snippet.type === "css"
                                  ? "var(--orca-primary-color, #007bff)"
                                  : "var(--orca-accent-color, #28a745)"
                              }`,
                            },
                          },
                          snippet.content
                        )
                      )
                    )
                  )
                )
          )
        )
      );
    };

    // 渲染管理器对话框
    const container = document.createElement("div");
    container.id = `${this.pluginName}-manager-container`;
    document.body.appendChild(container);

    const root = window.createRoot(container);
    
    // 创建编辑对话框的独立容器
    const editContainer = document.createElement("div");
    editContainer.id = `${this.pluginName}-edit-container`;
    document.body.appendChild(editContainer);
    
    const editRoot = window.createRoot(editContainer);

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

      // 监听打开编辑对话框的事件
      React.useEffect(() => {
        const handleOpenEdit = (e: CustomEvent) => {
          if (e.detail.type === "add") {
            setIsAdding(true);
            setEditVisible(true);
            setFormData({ name: "", content: "", type: "css", enabled: true });
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
              width: "80vw",
              maxWidth: "800px",
              backgroundColor: "var(--orca-bg-primary, #fff)",
              borderRadius: "8px",
              padding: "24px",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
            },
          },
          React.createElement(
            "h3",
            { style: { margin: 0 } },
            isAdding ? "Add Snippet" : "Edit Snippet"
          ),
          React.createElement(Input, {
            placeholder: "Snippet name",
            value: formData.name,
            onChange: (e: any) =>
              setFormData({ ...formData, name: e.target.value }),
          }),
          React.createElement(
            "div",
            {
              style: {
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              },
            },
            React.createElement(
              "label",
              {
                style: {
                  fontSize: "14px",
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
          ),
          React.createElement("textarea", {
            value: formData.content,
            onChange: (e: any) =>
              setFormData({ ...formData, content: e.target.value }),
            placeholder: `Enter ${formData.type.toUpperCase()} code...`,
            style: {
              width: "100%",
              minHeight: "300px",
              padding: "12px",
              fontFamily: "monospace",
              fontSize: "14px",
              border: "1px solid var(--orca-border-color, #e0e0e0)",
              borderRadius: "4px",
              resize: "vertical",
            },
          }),
          React.createElement(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: "8px",
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

    root.render(React.createElement(ManagerDialog));
    
    editRoot.render(React.createElement(EditDialog));
  }
}
