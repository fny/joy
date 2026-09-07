import ExpoModulesCore

/**
 * Exposes JoySelectableTextView to JS as <JoySelectableText />.
 *
 * iOS only. Android's RN Text already supports real selection, and web has
 * native browser selection, so both keep the ordinary <Text> path.
 */
public class JoySelectableTextModule: Module {
  public func definition() -> ModuleDefinition {
    Name("JoySelectableText")

    View(JoySelectableTextView.self) {
      Events("onContentSizeChange", "onLinkPress")

      Prop("spans") { (view: JoySelectableTextView, spans: [JoyTextSpan]) in
        view.setSpans(spans)
      }

      Prop("textStyle") { (view: JoySelectableTextView, style: JoyTextStyle) in
        view.setTextStyle(style)
      }
    }
  }
}
