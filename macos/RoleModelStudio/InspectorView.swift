import SwiftUI

/// The native right-hand panel: the page's controls for whatever is open.
struct InspectorView: View {
    @EnvironmentObject private var web: StudioWeb

    var body: some View {
        Form {
            ForEach(sections) { section in
                Section {
                    ForEach(section.items) { item in
                        InspectorRow(web: web, palette: web.palette, item: item)
                            .equatable()
                    }
                } header: {
                    if let heading = section.heading {
                        SectionHeading(web: web, item: heading)
                            .equatable()
                    }
                }
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .background(Color("StudioPanel"))
    }

    private struct InspectorGroup: Identifiable {
        let id: String
        let heading: InspectorItem?
        var items: [InspectorItem]
    }

    /// Controls under the heading before them; anything ahead of the first
    /// heading forms a section of its own.
    private var sections: [InspectorGroup] {
        var groups: [InspectorGroup] = []
        for item in web.inspector {
            if item.kind == .section {
                groups.append(InspectorGroup(id: item.id, heading: item, items: []))
            } else if groups.isEmpty {
                groups.append(InspectorGroup(id: "top", heading: nil, items: [item]))
            } else {
                groups[groups.count - 1].items.append(item)
            }
        }
        return groups
    }
}

/// The rows hold the bridge as a plain reference, not an observed one: observed,
/// every row redraws whenever anything in the page changes, and a view like the
/// Creator has a hundred of them. Each row redraws when its own item does.
private struct SectionHeading: View, Equatable {
    let web: StudioWeb
    let item: InspectorItem

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.item == rhs.item }

    var body: some View {
        if let toggleID = item.toggleID {
            Toggle(item.label, isOn: Binding(
                get: { item.toggleOn },
                set: { web.inspectorSet(toggleID, value: String($0), commit: true) }
            ))
            .toggleStyle(.switch)
            .controlSize(.mini)
        } else {
            Text(item.label)
        }
    }
}

private struct InspectorRow: View, Equatable {
    let web: StudioWeb
    let palette: [InspectorSwatchFamily]
    let item: InspectorItem

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.item == rhs.item && (lhs.item.kind != .color || lhs.palette.count == rhs.palette.count)
    }

    var body: some View {
        switch item.kind {
        case .section:
            EmptyView()
        case .range:
            LabeledContent(item.label) {
                HStack {
                    slider
                    Text(item.display)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 36, alignment: .trailing)
                }
            }
            .disabled(item.disabled)
        case .number:
            TextField(item.label, text: text(commitOnChange: false))
                .onSubmit { web.inspectorSet(item.id, value: item.value, commit: true) }
                .disabled(item.disabled)
        case .text:
            TextField(item.label, text: text(commitOnChange: false), prompt: Text(item.placeholder))
                .onSubmit { web.inspectorSet(item.id, value: item.value, commit: true) }
                .disabled(item.disabled)
        case .password:
            SecureField(item.label, text: text(commitOnChange: false), prompt: Text(item.placeholder))
                .onSubmit { web.inspectorSet(item.id, value: item.value, commit: true) }
                .disabled(item.disabled)
        case .textarea:
            VStack(alignment: .leading, spacing: 4) {
                if !item.label.isEmpty { Text(item.label) }
                TextEditor(text: text(commitOnChange: true))
                    .font(.callout.monospaced())
                    .frame(minHeight: 90)
                    .scrollContentBackground(.hidden)
                    .background(Color("StudioBlack"), in: .rect(cornerRadius: 6))
            }
            .disabled(item.disabled)
        case .select:
            Picker(item.label, selection: Binding(
                get: { item.value },
                set: { web.inspectorSet(item.id, value: $0, commit: true) }
            )) {
                ForEach(item.options, id: \.self) { option in
                    Text(option.label).tag(option.value)
                }
            }
            .disabled(item.disabled)
        case .checkbox:
            Toggle(item.label, isOn: Binding(
                get: { item.checked },
                set: { web.inspectorSet(item.id, value: String($0), commit: true) }
            ))
            .disabled(item.disabled)
        case .button, .file:
            let button = Button(item.kind == .file ? (item.label.isEmpty ? "Choose File…" : item.label) : item.label) {
                web.inspectorPress(item.id)
            }
            .frame(maxWidth: .infinity)
            .disabled(item.disabled)
            if item.prominent {
                button.buttonStyle(.borderedProminent)
            } else {
                button
            }
        case .color:
            ColorMenuRow(web: web, palette: palette, item: item)
        }
    }

    /// A step of "any" is a continuous slider; a stepped one snaps like the page's.
    @ViewBuilder
    private var slider: some View {
        let range = item.min...max(item.max, item.min + 1)
        let finished: (Bool) -> Void = { editing in
            if !editing { web.inspectorSet(item.id, value: item.value, commit: true) }
        }
        // Snapped in the binding, not by Slider(step:), which draws a tick for
        // every step: a 0–1920 slider would be a solid bar of them.
        Slider(value: number, in: range, onEditingChanged: finished)
    }

    private var number: Binding<Double> {
        Binding(
            get: { Double(item.value) ?? item.min },
            set: { raw in
                let snapped = item.step > 0 ? item.min + ((raw - item.min) / item.step).rounded() * item.step : raw
                web.inspectorSet(item.id, value: Self.format(snapped, step: item.step), commit: false)
            }
        )
    }

    private func text(commitOnChange: Bool) -> Binding<String> {
        Binding(
            get: { item.value },
            set: { web.inspectorSet(item.id, value: $0, commit: commitOnChange) }
        )
    }

    /// The page's own precision: a step of 0.05 sends "0.35", not "0.35000000000000003".
    private static func format(_ value: Double, step: Double) -> String {
        if step == 0 { return String(format: "%.3f", value) }
        guard step < 1 else { return String(Int(value.rounded())) }
        let places = max(0, Int((-log10(step)).rounded(.up)))
        return String(format: "%.\(places)f", value)
    }
}

/// The page's colour menu: a chip that opens the brand's colour families.
private struct ColorMenuRow: View {
    let web: StudioWeb
    let palette: [InspectorSwatchFamily]
    let item: InspectorItem
    @State private var open = false

    var body: some View {
        LabeledContent(item.label.isEmpty ? "Colour" : item.label) {
            Button {
                open.toggle()
            } label: {
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color(hex: item.chip))
                        .frame(width: 18, height: 18)
                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(.white.opacity(0.2)))
                    Text(item.value).monospaced()
                }
            }
            .popover(isPresented: $open, arrowEdge: .leading) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(palette) { family in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(family.name).font(.caption).foregroundStyle(.secondary)
                                HStack(spacing: 2) {
                                    ForEach(family.swatches) { swatch in
                                        Button {
                                            web.inspectorSwatch(item.id, title: swatch.title)
                                            open = false
                                        } label: {
                                            Rectangle().fill(Color(hex: swatch.hex))
                                                .frame(width: 18, height: 18)
                                        }
                                        .buttonStyle(.plain)
                                        .help(swatch.title)
                                    }
                                }
                            }
                        }
                    }
                    .padding(12)
                }
                .frame(width: 420, height: 460)
            }
        }
    }
}

extension Color {
    /// "#rrggbb", as the page reports a computed colour.
    init(hex: String) {
        let digits = UInt32(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0
        self.init(
            red: Double((digits >> 16) & 0xFF) / 255,
            green: Double((digits >> 8) & 0xFF) / 255,
            blue: Double(digits & 0xFF) / 255
        )
    }
}
