// swift-tools-version: 5.9
//
// WotchMobile - iOS companion app for Wotch desktop
//
// This Package.swift is provided as a reference for dependencies.
// The actual project uses the Xcode project file (WotchMobile.xcodeproj).
//
// To add SSH support, add one of these packages in Xcode:
//   - CitadelSSH: https://github.com/orlandos-nl/Citadel.git (SwiftNIO-based, pure Swift)
//   - NMSSH: https://github.com/NMSSH/NMSSH.git (libssh2 wrapper, mature)
//   - Shout: https://github.com/jakeheis/Shout.git (libssh2 wrapper, simpler API)

import PackageDescription

let package = Package(
    name: "WotchMobile",
    platforms: [
        .iOS(.v17),
    ],
    products: [
        .library(name: "WotchMobile", targets: ["WotchMobile"]),
    ],
    dependencies: [
        // Uncomment one SSH library:
        // .package(url: "https://github.com/orlandos-nl/Citadel.git", from: "0.7.0"),
        // .package(url: "https://github.com/jakeheis/Shout.git", from: "0.6.0"),
    ],
    targets: [
        .target(
            name: "WotchMobile",
            dependencies: [
                // Uncomment matching dependency:
                // .product(name: "Citadel", package: "Citadel"),
                // .product(name: "Shout", package: "Shout"),
            ],
            path: "WotchMobile"
        ),
    ]
)
