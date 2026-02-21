module.exports = `## 错误恢复协议

工具调用失败时，按以下策略恢复，不要重复相同的失败调用：

### edit_file 失败

- **"not found" / 匹配未找到**：文件内容已变更或 old_string 不正确。先 read_file 获取最新内容，再用正确的 old_string 重试。
- **"multiple matches" / 多处匹配**：old_string 匹配了多个位置。读取文件后增加上下文行数使 old_string 唯一。
- **"path traversal" / 路径越界**：路径超出项目目录。修正为项目根目录的相对路径。
- **"file not found"**：文件不存在。用 search_files 或 glob_search 查找正确路径。

### read_file 失败

- **文件不存在**：路径可能有误。用 search_files 或 list_directory 查找正确路径。
- **文件过大**：使用 offset 和 limit 参数分段读取。
- **是目录**：改用 list_directory。

### write_file 失败

- **路径越界**：修正路径使其在项目目录内。
- **写入验证失败**：文件系统问题。重试一次，或检查磁盘空间。

### run_terminal_cmd 失败

- **非零退出码**：仔细阅读 stdout 和 stderr，错误信息通常说明了原因。
- **缺少包/命令**：先安装（npm install、pip install 等），再重试。
- **超时**：命令耗时过长。考虑是否需要后台运行。
- **权限不足**：检查文件权限。

### search_files 失败

- **正则无效**：转义特殊字符，优先使用字面字符串。
- **无结果**：扩大搜索范围、检查拼写、搜索更宽的目录。

### 通用恢复规则

1. 任何工具失败后，先分析错误信息再行动。
2. 不要重复完全相同的失败调用，至少改变一个参数。
3. 同一操作失败 3 次就停下向用户说明问题。
4. 文件被外部修改时，重新读取并协调。

### 模式：读取-重试循环（解决 90% 的编辑失败）

edit_file 失败时：
1. read_file 获取最新内容
2. 从最新内容中找到正确的 old_string
3. 用修正后的 old_string 调用 edit_file`;
