# Orca 代码片段加载工具插件

这是一个为虎鲸笔记（Orca Note）开发的 JS 和 CSS 代码片段管理插件。

## 功能特性

- ✅ 创建、编辑、删除 CSS 和 JavaScript 代码片段
- ✅ 动态启用/禁用代码片段
- ✅ 代码片段自动注入到页面中
- ✅ JavaScript 语法验证
- ✅ 友好的管理界面
- ✅ 支持国际化（中文/英文）

## 安装

将插件文件夹（包含 `dist/`、`icon.svg`、`plugin.json`）复制到 `orca/plugins/orca-snippets-plugin/` 目录下。

## 使用方法

1. 点击顶栏的代码图标按钮，或使用命令 `orca-snippets-plugin.openManager` 打开管理器
2. 点击"添加代码片段"创建新的代码片段
3. 选择代码类型（CSS 或 JavaScript）
4. 输入代码内容
5. 启用代码片段后，它会自动注入到页面中

## 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build
```

## 注意事项

1. JavaScript 代码会直接执行，请注意安全性
2. 代码片段之间可能存在变量/函数名冲突，请注意命名规范
3. 禁用插件时会自动清理所有注入的代码片段

## 许可证

MIT
