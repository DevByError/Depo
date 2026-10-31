mod engine;

use engine::{EngineConnection, EngineState};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Runtime};

/// Returns the engine port and token once the sidecar is ready (waits up to 20 s).
#[tauri::command]
async fn engine_connection(state: tauri::State<'_, EngineState>) -> Result<EngineConnection, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(conn) = state.connection() {
            return Ok(conn);
        }
        if Instant::now() > deadline {
            return Err(state
                .last_error()
                .unwrap_or_else(|| "The Depo engine did not start in time.".to_string()));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Depo", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Depo", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Depo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => {
                app.state::<EngineState>().shutdown();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn run() {
    let state = match EngineState::new() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![engine_connection])
        .setup(|app| {
            build_tray(app.handle())?;
            if let Err(e) = engine::spawn(app.handle()) {
                log::error!("{e}");
                app.state::<EngineState>().set_error(e);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Depo");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            app.state::<EngineState>().shutdown();
        }
    });
}
