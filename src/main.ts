import { setupL10N, t } from "./libs/l10n";
import zhCN from "./translations/zhCN";
import { Snippet, SnippetManager } from "./snippet-manager";

let pluginName: string;
let snippetManager: SnippetManager;

export async function load(_name: string) {
  pluginName = _name;

  setupL10N(orca.state.locale, { "zh-CN": zhCN });

  // 注入 CodeMirror CSS
  if (!document.getElementById(`${pluginName}-codemirror-styles`)) {
    const style = document.createElement("style");
    style.id = `${pluginName}-codemirror-styles`;
    style.textContent = `
      .cm-editor {
        height: 100% !important;
      }
      .cm-scroller {
        overflow: auto !important;
      }
    `;
    document.head.appendChild(style);
  }

  // 初始化代码片段管理器
  snippetManager = new SnippetManager(pluginName);
  await snippetManager.init();

  // 加载所有启用的代码片段
  await snippetManager.loadAllEnabled();

  // 注册命令：打开代码片段管理器
  orca.commands.registerCommand(
    `${pluginName}.openManager`,
    async () => {
      await snippetManager.openManager();
    },
    t("openSnippetsManager", {}, orca.state.locale === "zh-CN" ? "zh-CN" : "en")
  );

  // 注册顶栏按钮
  orca.headbar.registerHeadbarButton(`${pluginName}.headbarButton`, () => {
    const Button = orca.components.Button;
    const React = window.React;
    return React.createElement(
      Button,
      {
        variant: "plain",
        onClick: (e: any) => {
          e?.stopPropagation();
          snippetManager.openManager().catch((error) => {
            orca.notify("error", `Failed to open manager: ${error.message}`);
          });
        },
        title: t("openSnippetsManager", {}, orca.state.locale === "zh-CN" ? "zh-CN" : "en"),
      },
      React.createElement("i", { className: "ti ti-code", style: { fontSize: "var(--orca-fontsize-lg)" } })
    );
  });
}

export async function unload() {
  // 清理所有注入的代码片段
  if (snippetManager) {
    snippetManager.cleanup();
  }

  // 取消注册命令
  orca.commands.unregisterCommand(`${pluginName}.openManager`);

  // 取消注册顶栏按钮
  orca.headbar.unregisterHeadbarButton(`${pluginName}.headbarButton`);
}
