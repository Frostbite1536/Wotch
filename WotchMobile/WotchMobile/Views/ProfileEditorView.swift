import SwiftUI
import UniformTypeIdentifiers

/// SSH profile editor — port of the desktop's SSH Profile Editor dialog.
///
/// Desktop fields: name, host, port, username, authMethod, keyPath
/// iOS equivalent: same fields, but key is imported via file picker into Keychain
struct ProfileEditorView: View {
    let profile: SSHProfile?
    let onSave: (SSHProfile) -> Void

    @StateObject private var viewModel: ProfileEditorViewModel
    @Environment(\.dismiss) private var dismiss

    init(profile: SSHProfile?, onSave: @escaping (SSHProfile) -> Void) {
        self.profile = profile
        self.onSave = onSave
        _viewModel = StateObject(wrappedValue: ProfileEditorViewModel(profile: profile))
    }

    var body: some View {
        NavigationStack {
            Form {
                connectionSection
                authSection

                if let error = viewModel.errorMessage {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }
            }
            .navigationTitle(profile == nil ? "New Connection" : "Edit Connection")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if let profile = viewModel.buildProfile() {
                            onSave(profile)
                            dismiss()
                        }
                    }
                }
            }
            .fileImporter(
                isPresented: $viewModel.showFilePicker,
                allowedContentTypes: [.data, .plainText],
                allowsMultipleSelection: false
            ) { result in
                handleFileImport(result)
            }
        }
    }

    // MARK: - Sections

    private var connectionSection: some View {
        Section("Connection") {
            TextField("Name (optional)", text: $viewModel.name)
                .textContentType(.nickname)

            TextField("Host", text: $viewModel.host)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)

            TextField("Port", text: $viewModel.port)
                .keyboardType(.numberPad)

            TextField("Username", text: $viewModel.username)
                .textContentType(.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
    }

    private var authSection: some View {
        Section("Authentication") {
            Picker("Method", selection: $viewModel.authMethod) {
                ForEach(SSHAuthMethod.allCases) { method in
                    Text(method.displayName).tag(method)
                }
            }

            if viewModel.authMethod == .key {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(viewModel.hasKeyLoaded ? "Key loaded" : "No key selected")
                            .font(.body)
                        if !viewModel.keyFileName.isEmpty {
                            Text(viewModel.keyFileName)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Spacer()

                    Button(viewModel.hasKeyLoaded ? "Change" : "Select Key") {
                        viewModel.showFilePicker = true
                    }
                    .buttonStyle(.bordered)
                }
            }

            if viewModel.authMethod == .password {
                Text("Password will be prompted each connection and never stored.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - File import

    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }
            // Access security-scoped resource
            guard url.startAccessingSecurityScopedResource() else {
                viewModel.errorMessage = "Unable to access file"
                return
            }
            defer { url.stopAccessingSecurityScopedResource() }

            do {
                let data = try Data(contentsOf: url)
                viewModel.importKey(data: data, fileName: url.lastPathComponent)
            } catch {
                viewModel.errorMessage = "Failed to read key: \(error.localizedDescription)"
            }

        case .failure(let error):
            viewModel.errorMessage = "File picker error: \(error.localizedDescription)"
        }
    }
}
