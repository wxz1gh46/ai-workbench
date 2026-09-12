//! Tauri 桌面壳。
//!
//! 设计要点：
//! - 前端通过本地 HTTP/WS 与 Node 侧 Agent Runtime 通信，壳本身不承载业务逻辑
//! - 工作目录选择使用系统原生对话框，路径交给服务端校验（服务端做路径穿越防护）
//! - 桌面通知走官方通知插件，Phase 3 的推送渠道在此扩展

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub root_path: Option<String>,
}

/// 校验用户选择的目录：必须存在且是目录
#[tauri::command]
fn validate_workspace_root(path: String) -> Result<WorkspaceInfo, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("目录不存在: {path}"));
    }
    if !p.is_dir() {
        return Err(format!("不是目录: {path}"));
    }
    Ok(WorkspaceInfo {
        root_path: Some(p.to_string_lossy().to_string()),
    })
}

/// 本地服务地址：开发态为 8787，打包后可指向 sidecar
#[tauri::command]
fn runtime_base_url() -> String {
    std::env::var("AI_WORKBENCH_RUNTIME_URL").unwrap_or_else(|_| "http://127.0.0.1:8787".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            validate_workspace_root,
            runtime_base_url
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
