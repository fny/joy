Pod::Spec.new do |s|
  s.name           = 'JoySelectableText'
  s.version        = '1.0.0'
  s.summary        = 'A UITextView-backed text view so iOS can select a phrase out of an agent message.'
  s.description    = 'RN Text `selectable` on iOS only offers copy-the-whole-paragraph. UITextView is the one UIKit control that draws selection handles over an attributed string.'
  s.author         = ''
  s.homepage       = 'https://github.com/fny/joy'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
