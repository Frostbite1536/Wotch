import SwiftUI
import Combine

/// Central app state shared across views via EnvironmentObject.
/// Mirrors the desktop app's pattern of a single settings + connection state.
final class AppState: ObservableObject {
    @Published var sshProfiles: [SSHProfile] = []
    @Published var activeConnections: [UUID: ConnectionState] = [:]
    @Published var selectedTheme: WotchTheme = .dark
    @Published var selectedProfileId: UUID?

    private let settingsService = SettingsService.shared

    init() {
        loadSettings()
    }

    func loadSettings() {
        sshProfiles = settingsService.loadProfiles()
        selectedTheme = settingsService.loadTheme()
    }

    func saveProfile(_ profile: SSHProfile) {
        if let idx = sshProfiles.firstIndex(where: { $0.id == profile.id }) {
            sshProfiles[idx] = profile
        } else {
            sshProfiles.append(profile)
        }
        settingsService.saveProfiles(sshProfiles)
    }

    func deleteProfile(_ profile: SSHProfile) {
        sshProfiles.removeAll { $0.id == profile.id }
        settingsService.saveProfiles(sshProfiles)
    }

    func setTheme(_ theme: WotchTheme) {
        selectedTheme = theme
        settingsService.saveTheme(theme)
    }
}
