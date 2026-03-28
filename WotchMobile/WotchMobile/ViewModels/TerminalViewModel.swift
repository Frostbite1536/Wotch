import Foundation
import Combine

/// ViewModel for a terminal session connected to a remote host.
/// Coordinates between SSHService, ClaudeStatusDetector, and the terminal view.
@MainActor
final class TerminalViewModel: ObservableObject {
    @Published var terminalOutput: String = ""
    @Published var connectionPhase: ConnectionPhase = .disconnected
    @Published var claudeStatus: ClaudeStatusInfo = .idle
    @Published var showHostKeyAlert = false
    @Published var showPasswordPrompt = false
    @Published var hostKeyFingerprint = ""
    @Published var hostKeyIsChanged = false

    let profile: SSHProfile
    private let sshService = SSHService.shared
    private let statusDetector = ClaudeStatusDetector()
    private var cancellables = Set<AnyCancellable>()

    /// Continuation for async host key verification flow
    private var hostKeyVerifyContinuation: CheckedContinuation<Bool, Never>?
    /// Continuation for async password prompt flow
    private var passwordContinuation: CheckedContinuation<String?, Never>?

    init(profile: SSHProfile) {
        self.profile = profile
        statusDetector.addTab(profile.id)
        setupCallbacks()
        observeStatus()
    }

    deinit {
        statusDetector.removeTab(profile.id)
    }

    // MARK: - Connection

    func connect(password: String? = nil) {
        Task {
            do {
                try await sshService.connect(profile: profile, password: password)
            } catch {
                connectionPhase = .failed(message: error.localizedDescription)
            }
        }
    }

    func disconnect() {
        sshService.disconnect(profile.id)
        connectionPhase = .disconnected
        WidgetDataService.shared.writeConnectionInfo(name: "", isConnected: false)
    }

    /// Send user input to the remote shell
    func sendInput(_ text: String) {
        sshService.write(profile.id, data: text)
    }

    /// Resize remote PTY when terminal view changes size
    func resize(cols: Int, rows: Int) {
        sshService.resize(profile.id, cols: cols, rows: rows)
    }

    // MARK: - Host key verification response (from UI)

    func acceptHostKey() {
        hostKeyVerifyContinuation?.resume(returning: true)
        hostKeyVerifyContinuation = nil
        showHostKeyAlert = false
    }

    func rejectHostKey() {
        hostKeyVerifyContinuation?.resume(returning: false)
        hostKeyVerifyContinuation = nil
        showHostKeyAlert = false
    }

    // MARK: - Password prompt response (from UI)

    func submitPassword(_ password: String) {
        passwordContinuation?.resume(returning: password)
        passwordContinuation = nil
        showPasswordPrompt = false
    }

    func cancelPassword() {
        passwordContinuation?.resume(returning: nil)
        passwordContinuation = nil
        showPasswordPrompt = false
    }

    // MARK: - Setup

    private func setupCallbacks() {
        sshService.onDataReceived = { [weak self] id, data in
            guard let self, id == self.profile.id else { return }
            Task { @MainActor in
                self.terminalOutput += data
                // Keep output buffer reasonable
                if self.terminalOutput.count > 50_000 {
                    self.terminalOutput = String(self.terminalOutput.suffix(40_000))
                }
            }
            self.statusDetector.feed(tabId: id, rawData: data)
        }

        sshService.onStateChanged = { [weak self] id, phase in
            guard let self, id == self.profile.id else { return }
            Task { @MainActor in
                self.connectionPhase = phase
                if case .connected = phase {
                    WidgetDataService.shared.writeConnectionInfo(
                        name: self.profile.displayName,
                        isConnected: true
                    )
                }
            }
        }

        sshService.onHostKeyVerification = { [weak self] id, fingerprint, isChanged in
            guard let self, id == self.profile.id else { return false }
            return await withCheckedContinuation { continuation in
                Task { @MainActor in
                    self.hostKeyFingerprint = fingerprint
                    self.hostKeyIsChanged = isChanged
                    self.hostKeyVerifyContinuation = continuation
                    self.showHostKeyAlert = true
                }
            }
        }

        sshService.onCredentialRequest = { [weak self] id, _ in
            guard let self, id == self.profile.id else { return nil }
            return await withCheckedContinuation { continuation in
                Task { @MainActor in
                    self.passwordContinuation = continuation
                    self.showPasswordPrompt = true
                }
            }
        }
    }

    private func observeStatus() {
        statusDetector.$perTabStatus
            .compactMap { $0[self.profile.id] }
            .receive(on: DispatchQueue.main)
            .assign(to: &$claudeStatus)
    }
}
