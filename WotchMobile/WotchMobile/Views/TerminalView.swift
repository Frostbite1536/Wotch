import SwiftUI

/// Terminal view for an active SSH connection.
/// Shows terminal output, status indicator, and input handling.
///
/// This is the iOS equivalent of the desktop's expanded panel with
/// xterm.js terminal — simplified for mobile with a text-based view
/// and on-screen keyboard input.
struct TerminalView: View {
    let profile: SSHProfile
    @StateObject private var viewModel: TerminalViewModel
    @State private var inputText = ""
    @State private var passwordInput = ""
    @EnvironmentObject var appState: AppState

    init(profile: SSHProfile) {
        self.profile = profile
        _viewModel = StateObject(wrappedValue: TerminalViewModel(profile: profile))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Status bar — mirrors the desktop pill
            statusBar

            // Terminal output
            terminalOutput

            // Input bar
            if viewModel.connectionPhase.isConnected {
                inputBar
            } else {
                connectButton
            }
        }
        .background(appState.selectedTheme.background)
        .navigationTitle(profile.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                statusDot
            }
        }
        .alert("Host Key Verification", isPresented: $viewModel.showHostKeyAlert) {
            Button("Accept", action: viewModel.acceptHostKey)
            Button("Reject", role: .cancel, action: viewModel.rejectHostKey)
        } message: {
            Text(hostKeyMessage)
        }
        .alert("Password Required", isPresented: $viewModel.showPasswordPrompt) {
            SecureField("Password", text: $passwordInput)
            Button("Connect") {
                viewModel.submitPassword(passwordInput)
                passwordInput = ""
            }
            Button("Cancel", role: .cancel) {
                viewModel.cancelPassword()
                passwordInput = ""
            }
        }
    }

    // MARK: - Status bar (mini pill)

    private var statusBar: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(viewModel.claudeStatus.state.color)
                .frame(width: 8, height: 8)
                .shadow(
                    color: viewModel.claudeStatus.state.color.opacity(0.5),
                    radius: viewModel.claudeStatus.state.shouldPulse ? 4 : 0
                )
                .animation(
                    viewModel.claudeStatus.state.shouldPulse
                        ? .easeInOut(duration: 1.5).repeatForever(autoreverses: true)
                        : .default,
                    value: viewModel.claudeStatus.state
                )

            Text(viewModel.connectionPhase.statusMessage)
                .font(.caption.monospaced())
                .foregroundStyle(appState.selectedTheme.textDim)

            if !viewModel.claudeStatus.description.isEmpty {
                Text("— \(viewModel.claudeStatus.description)")
                    .font(.caption.monospaced())
                    .foregroundStyle(appState.selectedTheme.textMuted)
                    .lineLimit(1)
            }

            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(appState.selectedTheme.background.opacity(0.95))
        .overlay(
            Rectangle()
                .frame(height: 1)
                .foregroundStyle(appState.selectedTheme.border),
            alignment: .bottom
        )
    }

    // MARK: - Terminal output

    private var terminalOutput: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(viewModel.terminalOutput)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(appState.selectedTheme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .id("terminal-bottom")
            }
            .onChange(of: viewModel.terminalOutput) { _, _ in
                withAnimation(.easeOut(duration: 0.1)) {
                    proxy.scrollTo("terminal-bottom", anchor: .bottom)
                }
            }
        }
        .background(appState.selectedTheme.terminalBackground)
    }

    // MARK: - Input bar

    private var inputBar: some View {
        HStack(spacing: 8) {
            // Quick action buttons (Ctrl+C, Tab, arrow keys)
            HStack(spacing: 4) {
                quickButton("^C") { viewModel.sendInput("\u{03}") }
                quickButton("Tab") { viewModel.sendInput("\t") }
                quickButton("↑") { viewModel.sendInput("\u{1B}[A") }
                quickButton("↓") { viewModel.sendInput("\u{1B}[B") }
            }

            TextField("Command...", text: $inputText)
                .font(.system(.body, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit {
                    viewModel.sendInput(inputText + "\n")
                    inputText = ""
                }

            Button {
                viewModel.sendInput(inputText + "\n")
                inputText = ""
            } label: {
                Image(systemName: "return")
                    .font(.body.weight(.semibold))
            }
            .tint(appState.selectedTheme.accent)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(appState.selectedTheme.background)
        .overlay(
            Rectangle()
                .frame(height: 1)
                .foregroundStyle(appState.selectedTheme.border),
            alignment: .top
        )
    }

    // MARK: - Connect button

    private var connectButton: some View {
        VStack(spacing: 12) {
            if case .failed(let msg) = viewModel.connectionPhase {
                Text(msg)
                    .font(.caption)
                    .foregroundStyle(Color(hex: "f87171"))
                    .padding(.horizontal)
            }

            Button {
                if profile.authMethod == .password {
                    viewModel.showPasswordPrompt = true
                } else {
                    viewModel.connect()
                }
            } label: {
                Label(
                    viewModel.connectionPhase == .disconnected ? "Connect" : "Reconnect",
                    systemImage: "bolt.fill"
                )
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(appState.selectedTheme.accent)
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
            .disabled(viewModel.connectionPhase.isActive)
        }
        .background(appState.selectedTheme.background)
    }

    // MARK: - Status dot (nav bar)

    private var statusDot: some View {
        Circle()
            .fill(viewModel.claudeStatus.state.color)
            .frame(width: 10, height: 10)
            .shadow(color: viewModel.claudeStatus.state.color.opacity(0.5), radius: 3)
    }

    // MARK: - Helpers

    private func quickButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.caption2.monospaced().weight(.medium))
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
                .background(appState.selectedTheme.accentDim)
                .cornerRadius(4)
        }
        .tint(appState.selectedTheme.text)
    }

    private var hostKeyMessage: String {
        if viewModel.hostKeyIsChanged {
            return "WARNING: The host key for this server has CHANGED.\n\nFingerprint: \(viewModel.hostKeyFingerprint)\n\nThis could indicate a man-in-the-middle attack."
        }
        return "First connection to this server.\n\nFingerprint: \(viewModel.hostKeyFingerprint)\n\nDo you trust this host?"
    }
}

// MARK: - ConnectionPhase convenience

private extension ConnectionPhase {
    var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }

    var isActive: Bool {
        switch self {
        case .connecting, .authenticating, .verifyingHostKey, .connected, .reconnecting:
            return true
        default:
            return false
        }
    }

    var statusMessage: String {
        switch self {
        case .disconnected: return "Disconnected"
        case .connecting: return "Connecting..."
        case .authenticating: return "Authenticating..."
        case .verifyingHostKey: return "Verify host key"
        case .connected: return "Connected"
        case .reconnecting: return "Reconnecting..."
        case .failed(let msg): return "Failed: \(msg)"
        }
    }
}
