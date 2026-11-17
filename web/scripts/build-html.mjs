// 构建期拼装 web/index.html。
//
// 运行时页面仍是单文件（后端用 include_str!("../web/index.html") 嵌入），
// 但源码按区块拆在 web/src/html/ 下：骨架 index.html 用独占一行的
// `<!-- include: NAME.html -->` 标记引用片段，本脚本递归展开后写回 web/index.html。
//
// 约定：
// - 片段内容原样拼接（保留缩进与行尾换行），拼装结果必须与拆分前的文件逐字节相同；
// - 标记必须独占一行（允许前导空白），否则视为残留标记并报错；
// - 仅使用 Node 标准库，不依赖当前工作目录。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** web/ 目录（本文件位于 web/scripts/）。 */
const webDir = fileURLToPath(new URL('..', import.meta.url));
/** 片段源码目录。 */
const srcDir = path.join(webDir, 'src', 'html');
/** 拼装入口（骨架）。 */
const entryFile = path.join(srcDir, 'index.html');
/** 生成的单文件页面（不入库）。 */
const outputFile = path.join(webDir, 'index.html');

/** 递归展开的最大深度，防止片段相互引用导致死循环。 */
const MAX_DEPTH = 8;
/** 片段名白名单：只允许单层文件名，禁止路径分隔符与 `..` 越界。 */
const SEGMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/;
/** 独占一行的 include 标记（允许前后空白）。 */
const INCLUDE_LINE = /^[ \t]*<!--[ \t]*include:[ \t]*([^>]*?)[ \t]*-->[ \t]*$/;
/** 任意位置残留的 include 标记，用于拼装后自检。 */
const RESIDUAL_MARKER = /<!--[ \t]*include:/;

/** 打印可操作的中文错误并以非零码退出。 */
function fail(message) {
  console.error(`错误: ${message}`);
  process.exit(1);
}

/** 读取片段并把换行保留在行尾，便于逐行原样输出。 */
function readLines(file) {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`无法读取片段 ${path.relative(srcDir, file)}：${reason}\n请确认文件存在且可读。`);
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1); // 丢弃片段自身的 BOM，输出统一无 BOM
  }
  // 每个元素都以 \n 结尾（最后一行若无换行也保持原样）；丢弃分割产生的空串。
  return text.split(/(?<=\n)/).filter((line) => line !== '');
}

/** 把片段名解析为 src/html 内的绝对路径，并校验不越界。 */
function resolveSegment(name) {
  if (!SEGMENT_NAME.test(name)) {
    fail(
      `非法的片段名 "${name}"：只允许字母、数字、点、下划线、连字符组成的单层 .html 文件名` +
        `（例如 stats.html），不允许路径分隔符或 ..`,
    );
  }
  const file = path.resolve(srcDir, name);
  const relative = path.relative(srcDir, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`片段 "${name}" 解析到 ${file}，超出了 ${srcDir} 目录范围，请检查标记。`);
  }
  return file;
}

/** 递归展开片段；chain 用于错误信息里展示引用链。 */
function expandFile(file, depth, chain, usedNames) {
  if (depth > MAX_DEPTH) {
    fail(
      `片段引用层级超过 ${MAX_DEPTH} 层，疑似循环引用：${chain.join(' → ')}\n` +
        `请拆掉互相引用的片段，或把公共部分合并到一个文件。`,
    );
  }
  const name = path.relative(srcDir, file);
  const lines = readLines(file);
  let output = '';
  for (const raw of lines) {
    // 去掉行尾换行后再匹配标记；标记整行（含换行）被片段内容替换。
    const line = raw.replace(/\r?\n$/, '');
    const match = INCLUDE_LINE.exec(line);
    if (!match) {
      output += raw;
      continue;
    }
    const segmentName = match[1];
    if (segmentName === '') {
      fail(`${name} 中存在空的 include 标记，标记需写成 <!-- include: 文件名.html -->`);
    }
    const segmentFile = resolveSegment(segmentName);
    if (!existsSync(segmentFile)) {
      fail(
        `缺少片段 ${segmentName}（在 ${name} 中被引用）：请在 ${srcDir} 下创建该文件，` +
          `或修正标记中的文件名。`,
      );
    }
    usedNames.add(segmentName);
    output += expandFile(segmentFile, depth + 1, [...chain, segmentName], usedNames);
  }
  return output;
}

const usedNames = new Set();
if (!existsSync(entryFile)) {
  fail(`缺少骨架 ${entryFile}：请确认 web/src/html/index.html 存在（片段源码入口）。`);
}
const html = expandFile(entryFile, 0, ['index.html'], usedNames);

const residual = RESIDUAL_MARKER.exec(html);
if (residual) {
  const lineNo = html.slice(0, residual.index).split('\n').length;
  fail(
    `拼装结果第 ${lineNo} 行仍有 include 标记残留：标记必须独占一行（可在行首留空白），` +
      `形如 <!-- include: stats.html -->。`,
  );
}

const bytes = Buffer.from(html, 'utf8');
writeFileSync(outputFile, bytes);
console.log(`web/index.html: ${bytes.length} 字节, ${usedNames.size + 1} 个片段`);
