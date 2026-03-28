import Foundation
import Combine

/// ViewModel for the connection list / home screen.
@MainActor
final class ConnectionListViewModel: ObservableObject {
    @Published var profiles: [SSHProfile] = []
    @Published var activeConnectionIds: Set<UUID> = []
    @Published var showAddProfile = false
    @Published var editingProfile: SSHProfile?

    private var cancellables = Set<AnyCancellable>()

    func load(from appState: AppState) {
        // Bind to appState
        appState.$sshProfiles
            .receive(on: DispatchQueue.main)
            .assign(to: &$profiles)
    }

    func addProfile() {
        editingProfile = SSHProfile()
        showAddProfile = true
    }

    func editProfile(_ profile: SSHProfile) {
        editingProfile = profile
        showAddProfile = true
    }

    func deleteProfile(_ profile: SSHProfile, appState: AppState) {
        // Disconnect if active
        if activeConnectionIds.contains(profile.id) {
            SSHService.shared.disconnect(profile.id)
            activeConnectionIds.remove(profile.id)
        }
        // Delete keychain data
        KeychainService.shared.deleteSSHKey(for: profile.id)
        // Remove profile
        appState.deleteProfile(profile)
    }
}
