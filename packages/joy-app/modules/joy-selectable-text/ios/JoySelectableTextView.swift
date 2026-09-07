import ExpoModulesCore
import UIKit

/// One styled run of text, as sent from JS. Mirrors `MarkdownSpan` on the
/// TypeScript side (`sources/components/markdown/parseMarkdown.ts`), flattened
/// into the booleans the attributed string actually needs.
struct JoyTextSpan: Record {
  @Field var text: String = ""
  @Field var bold: Bool = false
  @Field var italic: Bool = false
  @Field var code: Bool = false
  /// Absent for ordinary text; a URL makes the run a tappable link.
  @Field var url: String? = nil
}

/// The fonts and colours the JS side already resolved from the theme. Passed in
/// rather than hardcoded so this view never has to know about Unistyles, the
/// chat font scale, or which theme is active.
struct JoyTextStyle: Record {
  @Field var fontFamily: String = "System"
  @Field var fontFamilyBold: String? = nil
  @Field var fontFamilyItalic: String? = nil
  @Field var fontFamilyMono: String? = nil
  @Field var fontSize: Double = 16
  @Field var lineHeight: Double = 24
  /// #rrggbb / #rrggbbaa.
  @Field var color: String = "#000000"
  @Field var linkColor: String = "#0A7EA4"
  @Field var codeColor: String? = nil
  @Field var codeBackgroundColor: String? = nil
}

/**
 * A UITextView that renders an attributed string and nothing else.
 *
 * Why this exists (#641): React Native's `<Text selectable>` does not select on
 * iOS. Its Fabric view (RCTParagraphComponentView) attaches a long-press that
 * presents an edit menu whose only action is `copy:`, and `copy:` puts the
 * WHOLE attributedText on the pasteboard. No handles, no highlight, no partial
 * selection. UITextView is the single UIKit control that draws selection
 * handles over an attributed string, which is why every Apple surface you can
 * actually select text in (Notes, Mail, Safari) is one of these.
 *
 * Non-editable and non-scrolling: it is a paragraph, laid out by the JS side,
 * that happens to be selectable. Height is measured here and reported back,
 * because only this view knows how the attributed string wraps.
 */
final class JoySelectableTextView: ExpoView {
  private let textView = UITextView()
  private let onContentSizeChange = EventDispatcher()
  private let onLinkPress = EventDispatcher()

  private var spans: [JoyTextSpan] = []
  private var textStyle = JoyTextStyle()
  /// The last height handed to JS; resent only when it actually changes, so a
  /// re-layout at the same size does not loop through a JS state update.
  private var reportedHeight: CGFloat = -1

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true

    textView.isEditable = false
    textView.isSelectable = true          // the entire point
    textView.isScrollEnabled = false      // it is a paragraph, not a scroll view
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    // The list below is what stays in the edit menu on a selection. Left as the
    // system default deliberately: Copy, Look Up, Translate and Share are all
    // things you would want on a phrase out of an agent answer.
    textView.delegate = self
    textView.adjustsFontForContentSizeCategory = false
    addSubview(textView)
  }

  func setSpans(_ spans: [JoyTextSpan]) {
    self.spans = spans
    rebuild()
  }

  func setTextStyle(_ style: JoyTextStyle) {
    self.textStyle = style
    rebuild()
  }

  private func rebuild() {
    textView.attributedText = makeAttributedString()
    setNeedsLayout()
  }

  private func makeAttributedString() -> NSAttributedString {
    let result = NSMutableAttributedString()

    let paragraph = NSMutableParagraphStyle()
    // A line height below the font's natural leading would clip descenders, so
    // the JS value is a floor, not an override.
    paragraph.minimumLineHeight = CGFloat(textStyle.lineHeight)
    paragraph.maximumLineHeight = CGFloat(textStyle.lineHeight)
    paragraph.lineBreakMode = .byWordWrapping

    let baseColor = UIColor(hex: textStyle.color) ?? .label
    let linkColor = UIColor(hex: textStyle.linkColor) ?? .link
    let codeColor = textStyle.codeColor.flatMap { UIColor(hex: $0) } ?? baseColor
    let codeBackground = textStyle.codeBackgroundColor.flatMap { UIColor(hex: $0) }

    for span in spans {
      guard !span.text.isEmpty else { continue }

      var attributes: [NSAttributedString.Key: Any] = [
        .font: font(for: span),
        .paragraphStyle: paragraph,
        .foregroundColor: span.code ? codeColor : baseColor,
      ]

      if span.code, let codeBackground {
        attributes[.backgroundColor] = codeBackground
      }

      // A link run carries .link so UITextView makes it tappable; the tap is
      // routed to JS through the delegate below rather than opening here, so
      // the app keeps its own allowlist and in-app browser behaviour.
      if let url = span.url, let parsed = URL(string: url) {
        attributes[.link] = parsed
        attributes[.foregroundColor] = linkColor
      }

      result.append(NSAttributedString(string: span.text, attributes: attributes))
    }

    return result
  }

  private func font(for span: JoyTextSpan) -> UIFont {
    let size = CGFloat(textStyle.fontSize)

    let familyName: String?
    if span.code {
      familyName = textStyle.fontFamilyMono
    } else if span.bold {
      familyName = textStyle.fontFamilyBold ?? textStyle.fontFamily
    } else if span.italic {
      familyName = textStyle.fontFamilyItalic ?? textStyle.fontFamily
    } else {
      familyName = textStyle.fontFamily
    }

    // A custom family that failed to register must not silently drop the run to
    // an unstyled system face at a different width — fall back through the
    // system font with matching traits so the layout still reads correctly.
    if let familyName, let custom = UIFont(name: familyName, size: size) {
      return custom
    }

    if span.code {
      return UIFont.monospacedSystemFont(ofSize: size, weight: span.bold ? .semibold : .regular)
    }

    let base = UIFont.systemFont(ofSize: size, weight: span.bold ? .semibold : .regular)
    guard span.italic, let descriptor = base.fontDescriptor.withSymbolicTraits(.traitItalic) else {
      return base
    }
    return UIFont(descriptor: descriptor, size: size)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds

    // Only this view knows how the attributed string wrapped at this width, so
    // it measures and hands the height back for JS to apply. Yoga cannot size
    // it: the text is native and the font metrics live here.
    let available = CGSize(width: bounds.width, height: .greatestFiniteMagnitude)
    let measured = textView.sizeThatFits(available).height.rounded(.up)

    if bounds.width > 0 && abs(measured - reportedHeight) > 0.5 {
      reportedHeight = measured
      onContentSizeChange(["height": measured])
    }
  }
}

extension JoySelectableTextView: UITextViewDelegate {
  func textView(
    _ textView: UITextView,
    shouldInteractWith URL: URL,
    in characterRange: NSRange,
    interaction: UITextItemInteraction
  ) -> Bool {
    // Only a real tap is a link press. A long press here is the start of a
    // selection gesture, and opening a URL out from under it is exactly the
    // behaviour this whole module exists to avoid.
    guard interaction == .invokeDefaultAction else { return false }
    onLinkPress(["url": URL.absoluteString])
    return false
  }
}

private extension UIColor {
  /// #rgb, #rrggbb or #rrggbbaa, as produced by the JS theme.
  convenience init?(hex: String) {
    var value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.hasPrefix("#") { value.removeFirst() }

    if value.count == 3 {
      value = value.map { "\($0)\($0)" }.joined()
    }
    guard value.count == 6 || value.count == 8, let int = UInt64(value, radix: 16) else {
      return nil
    }

    let hasAlpha = value.count == 8
    let r = CGFloat((int >> (hasAlpha ? 24 : 16)) & 0xFF) / 255
    let g = CGFloat((int >> (hasAlpha ? 16 : 8)) & 0xFF) / 255
    let b = CGFloat((int >> (hasAlpha ? 8 : 0)) & 0xFF) / 255
    let a = hasAlpha ? CGFloat(int & 0xFF) / 255 : 1
    self.init(red: r, green: g, blue: b, alpha: a)
  }
}
