import Foundation

/// One control in the page's right-hand panel, as the native inspector draws it.
///
/// The page stays the owner: these are a reading of its controls, and every
/// change goes back to the element it came from as the same input, change or
/// click a person would have made. `id` names the element itself (kind and a
/// number the page keeps per element), not its label: the colour pickers label a
/// slider with its own value, so an id built from the label changed on every step
/// of a drag and the next step went to no control at all.
struct InspectorItem: Decodable, Identifiable, Equatable {
    enum Kind: String, Decodable {
        case section, range, number, text, textarea, password, select, checkbox, button, color, file
    }

    struct Option: Decodable, Equatable, Hashable {
        let value: String
        let label: String
    }

    let id: String
    let kind: Kind
    var label: String
    var value: String
    var checked: Bool
    var disabled: Bool
    var prominent: Bool
    var min: Double
    var max: Double
    var step: Double
    var display: String
    var placeholder: String
    var options: [Option]
    var chip: String
    /// A section heading that carries an on/off switch (Creator's "Waves").
    var toggleID: String?
    var toggleOn: Bool
}

/// A family of swatches in the page's colour menu.
struct InspectorSwatchFamily: Decodable, Identifiable, Equatable {
    struct Swatch: Decodable, Identifiable, Equatable {
        let title: String
        let hex: String
        var id: String { title }
    }

    let name: String
    let swatches: [Swatch]
    var id: String { name }
}

enum InspectorBridge {
    /// Moves the page's own panel out of sight (not `display: none`: its
    /// controls must still lay out, or their visibility cannot be read) and
    /// reports its controls whenever they change.
    static let script = #"""
    (() => {
      const panel = document.querySelector('.op-page__sidebar--right')
      if (!panel || window.__studioInspector) return
      const send = (body) => window.webkit.messageHandlers.inspector.postMessage(body)
      const byID = new Map()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const pen = canvas.getContext('2d', { willReadFrequently: true })
      const hex = (css) => {
        pen.clearRect(0, 0, 1, 1)
        pen.fillStyle = '#000'
        pen.fillStyle = css
        pen.fillRect(0, 0, 1, 1)
        const [r, g, b] = pen.getImageData(0, 0, 1, 1).data
        return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')
      }
      const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
      const shown = (el) => el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null
      // A label's own words, without a live readout inside it: the colour pickers
      // label a slider "L22.7%", and that text changes on every step of a drag.
      const labelText = (label) => {
        const copy = label.cloneNode(true)
        copy.querySelectorAll('[class*="value"], .v, output').forEach((n) => n.remove())
        return text(copy)
      }
      const labelFor = (el) => {
        const own = el.labels?.[0] ?? null
        if (own && labelText(own)) return labelText(own)
        const aria = el.getAttribute('aria-label') || el.title || el.placeholder
        if (aria) return aria
        let prev = el.previousElementSibling
        while (prev && !prev.matches('label, .form-label')) prev = prev.previousElementSibling
        const found = prev ? labelText(prev) : ''
        // A gradient stop's slider is labelled only by its colour's readout; what it sets is where the stop sits.
        return found || (el.type === 'range' ? 'Position' : '')
      }
      const kindOf = (el) => {
        if (el.matches('.colormenu')) return 'color'
        if (el.matches('.sec')) return 'section'
        if (el.tagName === 'SELECT') return 'select'
        if (el.tagName === 'TEXTAREA') return 'textarea'
        if (el.tagName === 'BUTTON') return 'button'
        return { range: 'range', number: 'number', checkbox: 'checkbox', password: 'password', file: 'file' }[el.type] ?? 'text'
      }
      let palette = null
      const readPalette = (menu) => [...menu.querySelectorAll('.colormenu__row')].map((row) => ({
        name: text(row.querySelector('.colormenu__family')),
        swatches: [...row.querySelectorAll('.colormenu__swatch')].map((b) => ({ title: b.title, hex: hex(getComputedStyle(b).backgroundColor) })),
      }))

      const ids = new WeakMap()
      let nextID = 0
      const idOf = (el) => {
        if (!ids.has(el)) ids.set(el, ++nextID)
        return ids.get(el)
      }

      const snapshot = () => {
        byID.clear()
        const items = []
        const nodes = panel.querySelectorAll('.sec, .colormenu, input, select, textarea, button')
        for (const el of nodes) {
          if (el.closest('.colormenu') && !el.matches('.colormenu')) continue
          if (el.closest('.sec') && !el.matches('.sec')) continue
          const kind = kindOf(el)
          if (kind !== 'file' && !shown(el)) continue
          // A file input the page hid on purpose is opened by a button beside it;
          // listing it as well put a second "Choose File…" in the panel.
          if (kind === 'file' && (el.hidden || !shown(el.parentElement))) continue
          const label = kind === 'section' ? text(el.querySelector('span') ?? el) : kind === 'button' ? (text(el).length > 1 ? text(el) : el.getAttribute('aria-label') || el.title || text(el)) : labelFor(el)
          // Identity is the element, not its words: a label that changes with its value
          // (or two that read the same) must not hand a drag to a different control.
          const id = `${kind}:${idOf(el)}`
          byID.set(id, el)
          const item = {
            id, kind, label, value: '', checked: false, disabled: !!el.disabled, prominent: false,
            min: 0, max: 1, step: 0, display: '', placeholder: '', options: [], chip: '', toggleID: null, toggleOn: false,
          }
          if (kind === 'section') {
            const box = el.querySelector('input[type=checkbox]')
            if (box) { item.toggleID = id + ':toggle'; item.toggleOn = box.checked; byID.set(item.toggleID, box) }
          } else if (kind === 'color') {
            item.chip = hex(getComputedStyle(el.querySelector('.colormenu__chip')).backgroundColor)
            item.value = text(el.querySelector('.colormenu__label'))
            palette ??= readPalette(el)
          } else if (kind === 'button') {
            item.prominent = el.classList.contains('btn') && !el.matches('.ghost, .btn--no-border, .btn--small')
          } else if (kind === 'checkbox') {
            item.checked = el.checked
          } else if (kind === 'select') {
            item.value = el.value
            item.options = [...el.options].map((o) => ({ value: o.value, label: text(o) || o.value }))
          } else {
            item.value = el.value
            item.placeholder = el.placeholder ?? ''
            if (kind === 'range' || kind === 'number') {
              item.min = Number(el.min || 0)
              item.max = Number(el.max || 100)
              item.step = el.step === 'any' ? 0 : Number(el.step || 1)
              const shownValue = el.nextElementSibling
              item.display = shownValue?.matches('.v') ? text(shownValue) : el.value
            }
          }
          items.push(item)
        }
        // Most mutations change nothing the native panel shows. Only say so when
        // something did, or the app decodes and compares the same panel again.
        const json = JSON.stringify(items)
        if (json === lastSent && (paletteSent || palette === null)) return
        lastSent = json
        send({ items, palette: paletteSent ? null : palette })
        paletteSent ||= palette !== null
      }
      let lastSent = ''
      let paletteSent = false

      let queued = false
      const schedule = () => {
        if (queued) return
        queued = true
        requestAnimationFrame(() => { queued = false; snapshot() })
      }
      new MutationObserver(schedule).observe(panel, { subtree: true, childList: true, attributes: true, characterData: true })
      panel.addEventListener('input', schedule, true)
      panel.addEventListener('change', schedule, true)

      window.__studioInspector = {
        set(id, value, commit) {
          const el = byID.get(id)
          if (!el) return
          if (el.type === 'checkbox') el.checked = value === 'true'
          else el.value = value
          el.dispatchEvent(new Event('input', { bubbles: true }))
          if (commit) el.dispatchEvent(new Event('change', { bubbles: true }))
        },
        press(id) { byID.get(id)?.click() },
        swatch(id, title) {
          const menu = byID.get(id)
          const swatch = [...(menu?.querySelectorAll('.colormenu__swatch') ?? [])].find((b) => b.title === title)
          swatch?.click()
        },
      }
      snapshot()
    })()
    """#

    /// The page's panel, out of view and out of the grid.
    static let hidePanelCSS = """
    .op-page > .op-page__sidebar--right { position: fixed !important; left: -10000px !important; top: 0 !important; width: 340px !important; }
    """
}
