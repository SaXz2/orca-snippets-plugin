# Orca 代码片段加载工具插件设计方案

## 概述

这是一个为虎鲸笔记（Orca Note）开发的 JS 和 CSS 代码片段管理插件，允许用户：
- 创建、编辑、删除 CSS 和 JavaScript 代码片段
- 动态启用/禁用代码片段
- 代码片段自动注入到页面中
- 提供友好的管理界面

## 核心功能

### 1. 数据存储
- 使用 `orca.plugins.setData()` 和 `orca.plugins.getData()` 持久化存储代码片段
- 存储格式：JSON 数组，包含所有代码片段信息

### 2. 代码注入
- CSS：创建 `<style>` 标签，注入到 `document.head`
- JavaScript：创建 `<script>` 标签，注入到 `document.head`
- 每个代码片段都有唯一 ID，便于管理

### 3. 代码验证
- JavaScript：使用 `Function` 构造函数进行语法检查
- 提供错误提示和修复建议

### 4. 管理界面
- 列表显示所有代码片段
- 支持添加、编辑、删除操作
- 快速启用/禁用切换
- 代码预览功能

### 5. 命令和快捷键
- 注册命令：`orca-snippets-plugin.openManager`
- 顶栏按钮：快速访问管理器

## 文件结构

```
src/
├── main.ts                    # 插件入口文件
├── snippet-manager.ts         # 代码片段管理器核心逻辑
├── snippet-ui.tsx            # UI 组件（使用 React）
├── libs/
│   └── l10n.ts               # 国际化工具
└── translations/
    └── zhCN.ts               # 中文翻译
```

## 数据结构

```typescript
interface Snippet {
  id: string;              // 唯一标识符
  name: string;            // 代码片段名称
  content: string;         // 代码内容
  type: "css" | "js";     // 代码类型
  enabled: boolean;       // 是否启用
  createdAt: number;      // 创建时间戳
  updatedAt: number;      // 更新时间戳
}
```

## API 使用

### 存储 API
```typescript
// 保存
await orca.plugins.setData(pluginName, "snippets", JSON.stringify(snippetsArray));

// 读取
const data = await orca.plugins.getData(pluginName, "snippets");
```

### 命令 API
```typescript
// 注册命令
orca.commands.registerCommand(`${pluginName}.openManager`, handler, label);

// 顶栏按钮
orca.headbar.registerHeadbarButton(`${pluginName}.headbarButton`, renderFn);
```

### UI 组件
使用 Orca 提供的 UI 组件：
- `orca.components.Button`
- `orca.components.ModalOverlay`
- `orca.components.Input`
- `orca.components.Select`
- `orca.components.Switch`
- `orca.components.ConfirmBox`

## 命名规范

遵循 Orca 插件开发规范：
- 所有标识符使用 `orca-snippets-plugin.` 前缀
- 避免使用下划线开头的名称
- 使用描述性的命名

## 生命周期

### load()
1. 初始化国际化
2. 创建 SnippetManager 实例
3. 加载存储的代码片段
4. 注入所有启用的代码片段
5. 注册命令和顶栏按钮

### unload()
1. 清理所有注入的代码片段
2. 取消注册命令和按钮
3. 清理资源

## 注意事项

1. **安全**：JavaScript 代码会直接执行，需要注意安全性
2. **性能**：大量代码片段可能影响性能，考虑按需加载
3. **冲突**：代码片段之间可能存在变量/函数名冲突
4. **错误处理**：完善的错误提示和异常处理

