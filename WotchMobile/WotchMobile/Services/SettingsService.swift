import Foundation

/// Persistence service for app settings.
/// Mirrors the desktop's ~/.wotch/settings.json pattern using iOS UserDefaults + Keychain.
///
/// Profiles are stored in UserDefaults (no secrets).
/// SSH keys and passwords are stored in Keychain (via KeychainService).
/// Known hosts are managed by KnownHostsService.
final class SettingsService {
    static let shared = SettingsService()

    private let defaults = UserDefaults.standard

    private enum Keys {
        static let sshProfiles = "wotch.sshProfiles"
        static let theme = "wotch.theme"
        static let lastConnectedProfileId = "wotch.lastConnectedProfileId"
    }

    // MARK: - SSH Profiles

    func loadProfiles() -> [SSHProfile] {
        guard let data = defaults.data(forKey: Keys.sshProfiles) else { return [] }
        return (try? JSONDecoder().decode([SSHProfile].self, from: data)) ?? []
    }

    func saveProfiles(_ profiles: [SSHProfile]) {
        if let data = try? JSONEncoder().encode(profiles) {
            defaults.set(data, forKey: Keys.sshProfiles)
        }
    }

    // MARK: - Theme

    func loadTheme() -> WotchTheme {
        guard let raw = defaults.string(forKey: Keys.theme) else { return .dark }
        return WotchTheme(rawValue: raw) ?? .dark
    }

    func saveTheme(_ theme: WotchTheme) {
        defaults.set(theme.rawValue, forKey: Keys.theme)
    }

    // MARK: - Last connected profile

    func loadLastConnectedProfileId() -> UUID? {
        guard let str = defaults.string(forKey: Keys.lastConnectedProfileId) else { return nil }
        return UUID(uuidString: str)
    }

    func saveLastConnectedProfileId(_ id: UUID?) {
        defaults.set(id?.uuidString, forKey: Keys.lastConnectedProfileId)
    }
}
