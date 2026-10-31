/// The Studio's views, as the native sidebar lists them.
///
/// `id` is the web view's own name for it — the value `go()` takes and
/// `data-v` carries in lib/studio.html. The order and groups follow that nav,
/// with one addition: Canvas, the storyboard, which lost its web button and
/// was reachable only from the Video steps.
struct StudioDestination: Identifiable, Hashable {
    let id: String
    let title: String
    let symbol: String
}

struct StudioSection: Identifiable {
    let id: String
    let title: String?
    let destinations: [StudioDestination]

    static let all: [StudioSection] = [
        StudioSection(id: "home", title: nil, destinations: [
            StudioDestination(id: "library", title: "Library", symbol: "books.vertical"),
        ]),
        StudioSection(id: "make", title: "Make a Video", destinations: [
            StudioDestination(id: "workflow", title: "Video", symbol: "video"),
            StudioDestination(id: "scripts", title: "Scripts", symbol: "doc.text"),
            StudioDestination(id: "voice", title: "Voice", symbol: "mic"),
            StudioDestination(id: "hyperframes", title: "Motion Editor", symbol: "wand.and.stars"),
            StudioDestination(id: "storyboard", title: "Canvas", symbol: "square.grid.3x2"),
            StudioDestination(id: "scenes", title: "Scenes", symbol: "rectangle.stack"),
            StudioDestination(id: "compose", title: "Compose", symbol: "list.number"),
            StudioDestination(id: "timeline", title: "Timeline", symbol: "timeline.selection"),
            StudioDestination(id: "restyle", title: "Restyle", symbol: "paintbrush"),
        ]),
        StudioSection(id: "toolkit", title: "Toolkit", destinations: [
            StudioDestination(id: "skills", title: "Skills", symbol: "sparkles"),
            StudioDestination(id: "brand", title: "Brand", symbol: "paintpalette"),
            StudioDestination(id: "truth", title: "Brand Truth", symbol: "checkmark.seal"),
            StudioDestination(id: "style", title: "Style", symbol: "photo.on.rectangle.angled"),
            StudioDestination(id: "creator", title: "Creator", symbol: "circle.hexagongrid"),
            StudioDestination(id: "showcase", title: "Showcase", symbol: "macbook.and.iphone"),
            StudioDestination(id: "moodboard", title: "Mood Board", symbol: "rectangle.3.group"),
            StudioDestination(id: "stickers", title: "Stickers", symbol: "seal"),
            StudioDestination(id: "wallpapers", title: "Wallpapers", symbol: "photo"),
            StudioDestination(id: "components", title: "Components", symbol: "square.on.square"),
        ]),
        StudioSection(id: "system", title: "System", destinations: [
            StudioDestination(id: "storage", title: "Storage", symbol: "externaldrive"),
            StudioDestination(id: "usage", title: "Usage", symbol: "chart.bar"),
            StudioDestination(id: "agents", title: "Agents", symbol: "person.2"),
            StudioDestination(id: "console", title: "Console", symbol: "terminal"),
        ]),
    ]

    static func destination(_ id: String) -> StudioDestination? {
        all.lazy.flatMap(\.destinations).first { $0.id == id }
    }
}
