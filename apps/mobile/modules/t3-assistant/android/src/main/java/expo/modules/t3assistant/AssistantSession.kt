package expo.modules.t3assistant

import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSession.AssistState
import android.text.InputType
import android.util.Log
import java.io.File
import kotlin.concurrent.thread

/**
 * Collects the screen context and opens the panel activity. Screen text arrives only on
 * Android 10 and later, through `onHandleAssist(AssistState)`.
 */
class AssistantSession(context: Context) : VoiceInteractionSession(context) {
  override fun onCreate() {
    super.onCreate()
    // The panel is an activity. The session window would sit above it and take its touches.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) setUiEnabled(false)
  }

  override fun onShow(args: Bundle?, showFlags: Int) {
    super.onShow(args, showFlags)
    AssistantCapture.begin(context, this)
    val panel = Intent(context, AssistantActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startAssistantActivity(panel)
    } else {
      context.startActivity(panel)
    }
  }

  override fun onHandleAssist(state: AssistState) {
    val structure = state.assistStructure
    AssistantCapture.addScreen(
      sourcePackage = structure?.activityComponent?.packageName,
      webUri = state.assistContent?.webUri?.toString(),
      screenText = structure?.let(::screenText),
      selectedText = structure?.let(::selectedText),
    )
  }

  override fun onHandleScreenshot(screenshot: Bitmap?) {
    if (screenshot == null) return
    val file = File(AssistantCapture.screenshotDirectory(context), "screen-${System.currentTimeMillis()}.jpg")
    // Compressing a full-screen bitmap takes long enough to delay the panel's first frame.
    thread(name = "t3-assistant-screenshot") {
      try {
        file.outputStream().use { screenshot.compress(Bitmap.CompressFormat.JPEG, SCREENSHOT_QUALITY, it) }
        AssistantCapture.setScreenshot(Uri.fromFile(file).toString(), screenshot.width, screenshot.height)
      } catch (error: Exception) {
        Log.w(TAG, "Could not save the assistant screenshot", error)
      }
    }
  }

  private fun screenText(structure: AssistStructure): String {
    val lines = LinkedHashSet<String>()
    fun visit(node: AssistStructure.ViewNode) {
      if (!isPassword(node)) {
        node.text?.toString()?.trim()?.takeIf(String::isNotEmpty)?.let(lines::add)
        node.contentDescription?.toString()?.trim()?.takeIf(String::isNotEmpty)?.let(lines::add)
      }
      for (index in 0 until node.childCount) visit(node.getChildAt(index))
    }
    for (index in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(index).rootViewNode)
    return lines.joinToString("\n").take(MAX_SCREEN_TEXT_CHARS)
  }

  /** The first non-empty text selection on screen, such as a highlighted sentence in a browser. */
  private fun selectedText(structure: AssistStructure): String? {
    fun visit(node: AssistStructure.ViewNode): String? {
      val text = node.text?.toString()
      val start = node.textSelectionStart
      val end = node.textSelectionEnd
      if (!isPassword(node) && text != null && start in 0 until end && end <= text.length) {
        return text.substring(start, end).trim().takeIf(String::isNotEmpty)
      }
      for (index in 0 until node.childCount) visit(node.getChildAt(index))?.let { return it }
      return null
    }
    for (index in 0 until structure.windowNodeCount) {
      visit(structure.getWindowNodeAt(index).rootViewNode)?.let { return it }
    }
    return null
  }

  private fun isPassword(node: AssistStructure.ViewNode): Boolean {
    val variation = node.inputType and InputType.TYPE_MASK_VARIATION
    return variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
      variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
      variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
      variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
  }

  private companion object {
    const val TAG = "T3Assistant"
    const val SCREENSHOT_QUALITY = 85
    const val MAX_SCREEN_TEXT_CHARS = 20_000
  }
}
