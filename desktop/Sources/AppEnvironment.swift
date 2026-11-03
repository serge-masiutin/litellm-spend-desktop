import AppKit
import Foundation

/// Пути установки остаются совместимыми с прежней панелью; сама .app не хранит личные данные.
struct AppEnvironment {
    let config: URL
    let resources: URL

    static var current: AppEnvironment {
        let path = ProcessInfo.processInfo.environment["LITELLM_SPEND_CONFIG"]
            ?? NSHomeDirectory() + "/.config/opencode/plugins/litellm-spend/config.json"
        return AppEnvironment(config: URL(fileURLWithPath: path), resources: Bundle.main.resourceURL!)
    }

    var defaults: URL { resources.appendingPathComponent("config.defaults.json") }
    var executable: URL { resources.deletingLastPathComponent().appendingPathComponent("MacOS/litellm-spend") }

    func prepare() throws {
        let manager = FileManager.default
        guard !manager.fileExists(atPath: config.path) else { return }
        try manager.createDirectory(at: config.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try manager.copyItem(at: defaults, to: config)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: config.path)
    }

    func root() throws -> [String: Any] {
        guard let root = try JSONSerialization.jsonObject(with: Data(contentsOf: config)) as? [String: Any] else {
            throw problem("В config.json ожидался объект")
        }
        return root
    }

    func storage(env: [String: String] = ProcessInfo.processInfo.environment) throws -> URL {
        let root = try root()
        guard let storage = root["storage"] as? [String: Any], let path = storage["dir"] as? String, !path.isEmpty else {
            throw problem("В config.json нет storage.dir")
        }
        let override = env["LITELLM_SPEND_DIR"]
        return URL(fileURLWithPath: ((override ?? path) as NSString).expandingTildeInPath)
    }

    func problem(_ message: String) -> NSError {
        NSError(domain: "LiteLLMSpend", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    /// Сохранение через общее ядро: один замок и формула для панели и плагина.
    func correctDailyBudget(day: String, amount: Double, storage: URL) throws {
        let process = Process()
        process.executableURL = executable
        process.arguments = ["correct-day", day, String(format: "%.10f", locale: Locale(identifier: "en_US_POSIX"), amount), "--config", config.path]
        var env = ProcessInfo.processInfo.environment
        env["LITELLM_SPEND_DIR"] = storage.path
        process.environment = env
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        try process.run()
        let result = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw problem(String(decoding: result, as: UTF8.self)) }
    }

    /// Установка выполняется только отдельным действием пользователя, не при запуске панели.
    func installAdapter() throws {
        guard config.lastPathComponent == "config.json" else {
            throw problem("Для установки адаптера используйте файл с именем config.json")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [resources.appendingPathComponent("plugin/install.sh").path, config.deletingLastPathComponent().path]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        try process.run()
        let result = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw problem(String(decoding: result, as: UTF8.self))
        }
    }
}
