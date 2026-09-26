import AVFoundation
import ExpoModulesCore

private enum VoiceAudioError: LocalizedError {
  case notRecording
  case invalidFile
  case unsupportedFormat

  var errorDescription: String? {
    switch self {
    case .notRecording: return "Voice recording is not active."
    case .invalidFile: return "Speech file is not a local file URI."
    case .unsupportedFormat: return "Voice input is not floating-point PCM."
    }
  }
}

/** All engine/player calls run on main; only AVAudioFile writes run on writerQueue. */
public final class JoyVoiceAudioModule: Module {
  private let writerQueue = DispatchQueue(label: "joy.voice.audio.writer")
  private let captureLock = NSLock()
  private var captureGeneration: UInt64 = 0
  private var captureActive = false
  private var lastLevelAt: TimeInterval = 0
  private var writer: AVAudioFile?
  private var writerURL: URL?
  private var engine: AVAudioEngine?
  private var tapInstalled = false
  private var player: AVAudioPlayerNode?
  private var playbackPromise: Promise?
  private var playbackGeneration: UInt64 = 0
  private var observers: [NSObjectProtocol] = []
  private var previousSession: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?

  public func definition() -> ModuleDefinition {
    Name("JoyVoiceAudio")
    Events("level", "error")

    OnCreate { [weak self] in self?.observeAudioChanges() }
    OnAppEntersBackground { [weak self] in self?.onMain { self?.closeAll() } }
    OnDestroy { [weak self] in
      self?.onMain {
        self?.closeAll()
        self?.observers.forEach { NotificationCenter.default.removeObserver($0) }
        self?.observers.removeAll()
      }
    }

    AsyncFunction("preparePlayback") { [weak self] in
      try self?.ensureEngine()
    }.runOnQueue(.main)

    AsyncFunction("startRecording") { [weak self] in
      guard let self else { return }
      try self.ensureEngine()
      self.stopCapture(deletePartial: true)
      guard let engine = self.engine else { return }
      let input = engine.inputNode
      let format = input.outputFormat(forBus: 0)
      guard format.commonFormat == .pcmFormatFloat32, format.channelCount > 0 else { throw VoiceAudioError.unsupportedFormat }
      let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false)!
      try self.writerQueue.sync { try self.openWriter(sampleRate: format.sampleRate) }
      self.captureLock.lock()
      self.captureGeneration &+= 1
      let generation = self.captureGeneration
      self.captureActive = true
      self.captureLock.unlock()
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
        guard let self else { return }
        self.captureLock.lock()
        let valid = self.captureActive && self.captureGeneration == generation
        self.captureLock.unlock()
        guard valid, let source = buffer.floatChannelData?[0],
              let copy = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: buffer.frameLength),
              let target = copy.floatChannelData?[0] else { return }
        copy.frameLength = buffer.frameLength
        memcpy(target, source, Int(buffer.frameLength) * MemoryLayout<Float>.size)
        let count = Int(buffer.frameLength)
        var power: Float = 0
        for i in 0..<count { power += target[i] * target[i] }
        let db = count > 0 && power > 0 ? 10 * log10(Double(power) / Double(count)) : -160
        self.writerQueue.async { [weak self] in
          guard let self else { return }
          self.captureLock.lock()
          let stillValid = self.captureActive && self.captureGeneration == generation
          self.captureLock.unlock()
          guard stillValid else { return }
          do { try self.writer?.write(from: copy) }
          catch {
            DispatchQueue.main.async { [weak self] in
              guard let self else { return }
              self.sendEvent("error", ["message": "Voice recording failed: \(error.localizedDescription)"])
              self.stopCapture(deletePartial: true)
            }
          }
        }
        DispatchQueue.main.async { [weak self] in
          guard let self else { return }
          self.captureLock.lock()
          let stillValid = self.captureActive && self.captureGeneration == generation
          self.captureLock.unlock()
          let now = ProcessInfo.processInfo.systemUptime
          if stillValid && now - self.lastLevelAt >= 0.1 {
            self.lastLevelAt = now
            self.sendEvent("level", ["db": db])
          }
        }
      }
      self.tapInstalled = true
    }.runOnQueue(.main)

    AsyncFunction("finishRecording") { [weak self] () throws -> String in
      guard let self else { throw VoiceAudioError.notRecording }
      self.captureLock.lock()
      let active = self.captureActive
      self.captureLock.unlock()
      guard active else { throw VoiceAudioError.notRecording }
      // A serial writer barrier puts all already-enqueued tap buffers in the
      // completed file, then opens its successor without stopping input.
      return try self.writerQueue.sync {
        guard let completed = self.writerURL else { throw VoiceAudioError.notRecording }
        let rate = self.writer?.processingFormat.sampleRate ?? 48000
        self.writer = nil
        self.writerURL = nil
        do { try self.openWriter(sampleRate: rate) }
        catch {
          try? FileManager.default.removeItem(at: completed)
          throw error
        }
        return completed.absoluteString
      }
    }.runOnQueue(.main)

    AsyncFunction("stopRecording") { [weak self] in
      self?.closeAll()
    }.runOnQueue(.main)

    AsyncFunction("play") { [weak self] (uri: String, promise: Promise) in
      guard let self else { promise.resolve(); return }
      do {
        self.stopCurrentPlayback()
        try self.ensureEngine()
        guard let url = URL(string: uri), url.isFileURL else { throw VoiceAudioError.invalidFile }
        let file = try AVAudioFile(forReading: url)
        guard let player = self.player else { throw VoiceAudioError.invalidFile }
        self.playbackGeneration &+= 1
        let generation = self.playbackGeneration
        self.playbackPromise = promise
        player.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
          DispatchQueue.main.async { [weak self] in
            guard let self, self.playbackGeneration == generation else { return }
            self.playbackPromise?.resolve()
            self.playbackPromise = nil
          }
        }
        player.play()
      } catch { promise.reject(error) }
    }.runOnQueue(.main)

    AsyncFunction("stopPlayback") { [weak self] in self?.stopCurrentPlayback() }.runOnQueue(.main)
    AsyncFunction("disposePlayback") { [weak self] in self?.closeAll() }.runOnQueue(.main)
  }

  private func openWriter(sampleRate: Double) throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("joy-voice-\(UUID().uuidString).wav")
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: sampleRate,
      AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
    ]
    writer = try AVAudioFile(forWriting: url, settings: settings)
    writerURL = url
  }

  private func ensureEngine() throws {
    if let engine, engine.isRunning { return }
    let session = AVAudioSession.sharedInstance()
    if previousSession == nil { previousSession = (session.category, session.mode, session.categoryOptions) }
    do {
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
      try session.setActive(true)
      let engine = AVAudioEngine()
      try engine.inputNode.setVoiceProcessingEnabled(true)
      let player = AVAudioPlayerNode()
      engine.attach(player)
      // Pocket's fixed 24 kHz mono WAV format is established before engine
      // start. The mixer converts it to the current speaker/headset format.
      let pocketFormat = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
      engine.connect(player, to: engine.mainMixerNode, format: pocketFormat)
      try engine.start()
      self.engine = engine
      self.player = player
    } catch {
      closeAll()
      throw error
    }
  }

  private func stopCapture(deletePartial: Bool) {
    captureLock.lock()
    captureActive = false
    captureGeneration &+= 1
    captureLock.unlock()
    if tapInstalled, let engine {
      engine.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }
    writerQueue.sync {
      writer = nil
      let partial = writerURL
      writerURL = nil
      if deletePartial, let partial { try? FileManager.default.removeItem(at: partial) }
    }
  }

  private func stopCurrentPlayback() {
    playbackGeneration &+= 1
    player?.stop()
    playbackPromise?.resolve()
    playbackPromise = nil
  }

  private func closeAll() {
    stopCapture(deletePartial: true)
    stopCurrentPlayback()
    engine?.stop()
    engine = nil
    player = nil
    if let previousSession {
      let session = AVAudioSession.sharedInstance()
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      try? session.setCategory(previousSession.category, mode: previousSession.mode, options: previousSession.options)
      self.previousSession = nil
    }
  }

  private func observeAudioChanges() {
    let notifications: [NSNotification.Name] = [
      AVAudioSession.interruptionNotification,
      AVAudioSession.routeChangeNotification,
    ]
    for name in notifications {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
        if name == AVAudioSession.routeChangeNotification,
           let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber,
           reason.uintValue == AVAudioSession.RouteChangeReason.categoryChange.rawValue { return }
        DispatchQueue.main.async { [weak self] in
          guard let self, self.engine != nil else { return }
          self.closeAll()
          self.sendEvent("error", ["message": "Audio route or session changed. Restart voice input."])
        }
      })
    }
  }

  private func onMain(_ work: () -> Void) {
    if Thread.isMainThread { work() }
    else { DispatchQueue.main.sync(execute: work) }
  }
}
