import SwiftUI

/// Reusable animated status dot — mirrors the desktop's pill dot with CSS animations.
///
/// Desktop CSS:
///   .status-idle:     green, no animation
///   .status-thinking: purple, pulse 1.5s
///   .status-working:  blue, pulse 2s
///   .status-waiting:  yellow, pulse 3s
///   .status-done:     green, no animation
///   .status-error:    red, no animation
struct StatusDotView: View {
    let state: ClaudeState
    var size: CGFloat = 10

    @State private var isPulsing = false

    var body: some View {
        Circle()
            .fill(state.color)
            .frame(width: size, height: size)
            .shadow(color: state.color.opacity(0.5), radius: isPulsing ? size * 0.6 : 0)
            .scaleEffect(isPulsing ? 1.2 : 1.0)
            .animation(pulseAnimation, value: isPulsing)
            .onChange(of: state) { _, newState in
                isPulsing = newState.shouldPulse
            }
            .onAppear {
                isPulsing = state.shouldPulse
            }
    }

    private var pulseAnimation: Animation? {
        guard state.shouldPulse else { return .default }
        let duration: Double = switch state {
        case .thinking: 1.5
        case .working: 2.0
        case .waiting: 3.0
        default: 1.5
        }
        return .easeInOut(duration: duration).repeatForever(autoreverses: true)
    }
}
