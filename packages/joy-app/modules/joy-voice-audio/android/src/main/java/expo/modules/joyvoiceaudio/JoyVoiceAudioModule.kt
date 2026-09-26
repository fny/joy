package expo.modules.joyvoiceaudio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Android recording stays in Expo Audio with VOICE_COMMUNICATION source. */
class JoyVoiceAudioModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context is unavailable")
  private var audioManager: AudioManager? = null
  private var previousMode: Int? = null
  private var previousSpeakerphone: Boolean? = null
  private var previousCommunicationDevice: AudioDeviceInfo? = null
  private var changedCommunicationDevice = false
  private var selectedSpeakerDevice: AudioDeviceInfo? = null
  private var changedSpeakerphone = false
  private var player: MediaPlayer? = null
  private var playbackPromise: Promise? = null
  private var playbackGeneration = 0L
  private val mainHandler = Handler(Looper.getMainLooper())

  override fun definition() = ModuleDefinition {
    Name("JoyVoiceAudio")
    Events("level", "error")

    AsyncFunction("preparePlayback") {
      prepareCommunicationMode()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("play") { uri: String, promise: Promise ->
      stopCurrentPlayback()
      try {
        prepareCommunicationMode()
        val parsed = Uri.parse(uri)
        if (parsed.scheme != "file") throw IllegalArgumentException("Speech file must be a local file URI")
        val next = MediaPlayer()
        player = next
        next.setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        )
        next.setDataSource(context, parsed)
        playbackGeneration++
        val generation = playbackGeneration
        playbackPromise = promise
        next.setOnPreparedListener { ready ->
          if (player === ready && playbackGeneration == generation) {
            try { ready.start() }
            catch (error: RuntimeException) {
              playbackGeneration++
              player = null
              ready.release()
              playbackPromise?.reject("VOICE_PLAYBACK", error.message ?: "Could not start speech", error)
              playbackPromise = null
            }
          }
        }
        next.setOnCompletionListener { finished ->
          if (player === finished && playbackGeneration == generation) stopCurrentPlayback()
        }
        next.setOnErrorListener { failed, what, extra ->
          if (player === failed && playbackGeneration == generation) {
            playbackGeneration++
            player = null
            failed.release()
            playbackPromise?.reject("VOICE_PLAYBACK", "MediaPlayer failed ($what, $extra)", null)
            playbackPromise = null
          }
          true
        }
        next.prepareAsync()
      } catch (error: Exception) {
        player?.release()
        player = null
        playbackPromise = null
        promise.reject("VOICE_PLAYBACK", error.message ?: "Could not play speech", error)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stopPlayback") { stopCurrentPlayback() }.runOnQueue(Queues.MAIN)
    AsyncFunction("disposePlayback") { dispose() }.runOnQueue(Queues.MAIN)

    // The shared JS surface is present on both platforms. Native capture is
    // iOS-only; Android's Expo recorder uses VOICE_COMMUNICATION as source.
    AsyncFunction("startRecording") { promise: Promise ->
      promise.reject("VOICE_RECORDING", "Use Expo Audio recording on Android", null)
    }
    AsyncFunction("finishRecording") { promise: Promise ->
      promise.reject("VOICE_RECORDING", "Use Expo Audio recording on Android", null)
    }
    AsyncFunction("stopRecording") {}

    OnActivityEntersBackground { disposeOnMain() }
    OnDestroy { disposeOnMain() }
  }

  private fun prepareCommunicationMode() {
    val manager = audioManager ?: (context.getSystemService(Context.AUDIO_SERVICE) as AudioManager).also { audioManager = it }
    if (previousMode == null) {
      previousMode = manager.mode
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) previousCommunicationDevice = manager.communicationDevice
      else previousSpeakerphone = manager.isSpeakerphoneOn
    }
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    // Communication mode may default to the earpiece. Choose the built-in
    // speaker only when the user has no wired, USB, or Bluetooth route.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val devices = manager.availableCommunicationDevices
      if (devices.none(::isExternalRoute)) {
        devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }?.let {
          if (manager.setCommunicationDevice(it)) {
            selectedSpeakerDevice = it
            changedCommunicationDevice = true
          }
        }
      }
    } else if (manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).none(::isExternalRoute)) {
      if (!manager.isSpeakerphoneOn) changedSpeakerphone = true
      manager.isSpeakerphoneOn = true
    }
  }

  private fun isExternalRoute(device: AudioDeviceInfo): Boolean = when (device.type) {
    AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
    AudioDeviceInfo.TYPE_USB_HEADSET,
    AudioDeviceInfo.TYPE_USB_DEVICE,
    AudioDeviceInfo.TYPE_USB_ACCESSORY,
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
    AudioDeviceInfo.TYPE_HEARING_AID -> true
    else -> Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
      (device.type == AudioDeviceInfo.TYPE_BLE_HEADSET || device.type == AudioDeviceInfo.TYPE_BLE_SPEAKER)
  }

  private fun stopCurrentPlayback() {
    playbackGeneration++
    val old = player
    player = null
    old?.setOnCompletionListener(null)
    old?.setOnErrorListener(null)
    old?.setOnPreparedListener(null)
    try { old?.stop() } catch (_: IllegalStateException) { /* still preparing */ }
    old?.release()
    playbackPromise?.resolve(null)
    playbackPromise = null
  }

  private fun dispose() {
    stopCurrentPlayback()
    val manager = audioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && changedCommunicationDevice &&
      manager?.communicationDevice?.id == selectedSpeakerDevice?.id) {
      val previous = previousCommunicationDevice
      if (previous == null || manager?.setCommunicationDevice(previous) != true) manager?.clearCommunicationDevice()
    } else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && changedSpeakerphone && manager != null &&
      manager.isSpeakerphoneOn && manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).none(::isExternalRoute)) {
      previousSpeakerphone?.let { manager.isSpeakerphoneOn = it }
    }
    previousMode?.let { mode -> audioManager?.mode = mode }
    previousMode = null
    previousSpeakerphone = null
    previousCommunicationDevice = null
    changedCommunicationDevice = false
    selectedSpeakerDevice = null
    changedSpeakerphone = false
  }

  private fun disposeOnMain() {
    if (Looper.myLooper() == Looper.getMainLooper()) dispose()
    else mainHandler.post { dispose() }
  }
}
