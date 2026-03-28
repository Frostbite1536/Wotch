import Foundation
import WidgetKit

/// Shared data bridge between the main app and the WidgetKit extension.
///
/// Uses an App Group container so both processes can read/write the same
/// UserDefaults. The main app writes status updates; the widget reads them.
final class WidgetDataService {
    static let shared = WidgetDataService()

    /// App Group identifier — must match the entitlement in both
    /// the main app target and the widget extension target.
    static let appGroupId = "group.com.wotch.mobile"

    private let defaults: UserDefaults?

    private enum Keys {
        static let claudeStatus = "widget.claudeStatus"
        static let lastUpdate = "widget.lastUpdate"
        static let connectionName = "widget.connectionName"
        static let isConnected = "widget.isConnected"
    }

    init() {
        defaults = UserDefaults(suiteName: Self.appGroupId)
    }

    // MARK: - Write (from main app)

    /// Write the current Claude status for the widget to display
    func writeStatus(_ status: ClaudeStatusInfo) {
        guard let defaults else { return }

        if let data = try? JSONEncoder().encode(status) {
            defaults.set(data, forKey: Keys.claudeStatus)
        }
        defaults.set(Date().timeIntervalSince1970, forKey: Keys.lastUpdate)

        // Tell WidgetKit to refresh
        WidgetCenter.shared.reloadTimelines(ofKind: "WotchStatusWidget")
    }

    /// Write connection info for the widget
    func writeConnectionInfo(name: String, isConnected: Bool) {
        guard let defaults else { return }
        defaults.set(name, forKey: Keys.connectionName)
        defaults.set(isConnected, forKey: Keys.isConnected)
    }

    // MARK: - Read (from widget extension)

    /// Read the current Claude status
    func readStatus() -> ClaudeStatusInfo {
        guard let defaults,
              let data = defaults.data(forKey: Keys.claudeStatus),
              let status = try? JSONDecoder().decode(ClaudeStatusInfo.self, from: data) else {
            return .idle
        }
        return status
    }

    /// Read the last update timestamp
    func readLastUpdate() -> Date? {
        guard let defaults else { return nil }
        let ts = defaults.double(forKey: Keys.lastUpdate)
        return ts > 0 ? Date(timeIntervalSince1970: ts) : nil
    }

    /// Read connection name
    func readConnectionName() -> String? {
        defaults?.string(forKey: Keys.connectionName)
    }

    /// Read connection state
    func readIsConnected() -> Bool {
        defaults?.bool(forKey: Keys.isConnected) ?? false
    }
}
