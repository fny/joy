Pod::Spec.new do |s|
  s.name           = 'JoyVoiceAudio'
  s.version        = '1.0.0'
  s.summary        = 'Voice processing capture and speech playback for Joy.'
  s.description    = 'Keeps the iOS voice-processing input and playback reference on one AVAudioEngine.'
  s.author         = ''
  s.homepage       = 'https://github.com/fny/joy'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
