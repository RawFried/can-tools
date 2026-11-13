//! 构建前校验前端产物是否存在。
//!
//! `web/app.js` 与 `web/app.css` 由 `cd web && npm run build` 生成且不入库;
//! 后端通过 `include_str!` 把它们嵌入二进制, 这里提前给出可操作的提示,
//! 避免缺失时只看到晦涩的宏展开错误。

use std::path::Path;

/// 必须存在的前端产物 (相对仓库根目录)。
const ARTIFACTS: [&str; 2] = ["web/app.js", "web/app.css"];

fn main() {
    for artifact in ARTIFACTS {
        println!("cargo:rerun-if-changed={artifact}");
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(artifact);
        let ready = std::fs::metadata(&path)
            .map(|metadata| metadata.is_file() && metadata.len() > 0)
            .unwrap_or(false);
        if !ready {
            eprintln!(
                "\n错误: 缺少前端产物 {artifact}\n\
                 请先在 web/ 目录执行: npm ci && npm run build\n"
            );
            std::process::exit(1);
        }
    }
}
