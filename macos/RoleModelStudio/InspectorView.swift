import SwiftUI

/// The native right-hand panel: the page's controls for whatever is open.
struct InspectorView: View {
    @EnvironmentObject private var web: StudioWeb

    var body: some View {
        Form {
            ForEach(sections) { section in
                Section {
                    ForEach(section.rows) { row in
                        if row.items.count == 1, let item = row.items.first {
                            InspectorRow(web: web, palette: web.palette, item: item)
                                .equatable()
                        } else {
                            // A run of buttons, two to a row: one per row made a
                            // panel of five actions as tall as the window.
                            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
                                ForEach(row.items) { item in
                                    InspectorRow(web: web, palette: web.palette, item: item)
                                        .equatable()
                                }
                            }
                        }
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
        // The bright brand green, not the window's AccentColor: that one is dark
        // enough for a selected sidebar row, and as the colour of every button
        // label and menu value on this panel it could not be read.
        .tint(Color("BrandGreen"))
    }

    private struct InspectorGroup: Identifiable {
        let id: String
        let heading: InspectorItem?
        var items: [InspectorItem]

        /// One control per row, except that buttons in a run share rows.
        var rows: [InspectorLine] {
            var lines: [InspectorLine] = []
            for item in items {
                let isButton = item.kind == .button && !item.prominent
                if isButton, let last = lines.last, last.buttons {
                    lines[lines.count - 1].items.append(item)
                } else {
                    lines.append(InspectorLine(items: [item], buttons: isButton))
                }
            }
            return lines
        }
    }

    private struct InspectorLine: Identifiable {
        var items: [InspectorItem]
        let buttons: Bool
        var id: String { items.first?.id ?? "" }
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
                slider
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
            // The chosen value in the label colour: tinted, it was green on grey.
            .tint(.primary)
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
                // A plain bordered button with a label you can read; tinted, its
                // text was the panel's green on the panel's grey.
                button.buttonStyle(.bordered).tint(.primary)
            }
        case .color:
            ColorMenuRow(web: web, palette: palette, item: item)
        }
    }

    /// A step of "any" is a continuous slider; a stepped one snaps like the page's.
    private var slider: some View {
        InspectorSlider(web: web, item: item)
    }

    private func text(commitOnChange: Bool) -> Binding<String> {
        Binding(
            get: { item.value },
            set: { web.inspectorSet(item.id, value: $0, commit: commitOnChange) }
        )
    }

    /// The page's own precision: a step of 0.05 sends "0.35", not "0.35000000000000003".
    fileprivate static func format(_ value: Double, step: Double) -> String {
        if step == 0 { return String(format: "%.3f", value) }
        guard step < 1 else { return String(Int(value.rounded())) }
        let places = max(0, Int((-log10(step)).rounded(.up)))
        return String(format: "%.\(places)f", value)
    }
}

/*
 * A slider that owns its value while it is being dragged.
 *
 * It used to read and write the shared reading of the page, which broke a drag
 * two ways: the release committed the value the slider had when the drag began
 * (the callback held the row as it was then), so every drag snapped back; and the
 * page's own reports during the drag redrew the row under the pointer. Now the
 * drag keeps a draft, sends each value straight to the page, holds the page's
 * reports until it ends, and commits the value it ended on.
 */
private struct InspectorSlider: View {
    let web: StudioWeb
    let item: InspectorItem
    @State private var draft: Double?

    var body: some View {
        HStack {
            // Snapped in the binding, not by Slider(step:), which draws a tick for
            // every step: a 0–1920 slider would be a solid bar of them.
            Slider(value: value, in: item.min...max(item.max, item.min + 1)) { editing in
                if editing {
                    web.inspectorBeginEditing(item.id)
                } else {
                    if let draft { web.inspectorSet(item.id, value: text(for: draft), commit: true) }
                    draft = nil
                    web.inspectorEndEditing()
                }
            }
            Text(draft.map { text(for: $0) } ?? item.display)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 36, alignment: .trailing)
        }
    }

    private var value: Binding<Double> {
        Binding(
            get: { draft ?? Double(item.value) ?? item.min },
            set: { raw in
                let snapped = item.step > 0 ? item.min + ((raw - item.min) / item.step).rounded() * item.step : raw
                draft = snapped
                web.inspectorSend(item.id, value: text(for: snapped))
            }
        )
    }

    private func text(for value: Double) -> String {
        InspectorRow.format(value, step: item.step)
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
                    Text(item.value)
                        .foregroundStyle(.primary)
                }
            }
            .buttonStyle(.bordered)
            .tint(.primary)
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
