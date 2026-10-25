package expo.modules.t3assistant

import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
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
      screenInfo = screenInfo(state),
    )
  }

  /** The raw fields that could name the screen: app, category, link, open file, titles. */
  private fun screenInfo(state: AssistState): String {
    val structure = state.assistStructure
    val content = state.assistContent
    val packageName = structure?.activityComponent?.packageName
    val app = packageName?.let { name ->
      runCatching { context.packageManager.getApplicationInfo(name, 0) }.getOrNull()
    }
    val category = app?.let { info ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && info.category != ApplicationInfo.CATEGORY_UNDEFINED) {
        ApplicationInfo.getCategoryTitle(context, info.category)?.toString() ?: info.category.toString()
      } else {
        null
      }
    }
    val titles = structure?.let { (0 until it.windowNodeCount).map { index -> it.getWindowNodeAt(index).title?.toString() } }
    val domains = LinkedHashSet<String>()
    val classes = HashMap<String, Int>()
    fun visit(node: AssistStructure.ViewNode) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) node.webDomain?.let(domains::add)
      node.className?.let { classes[it] = (classes[it] ?: 0) + 1 }
      for (index in 0 until node.childCount) visit(node.getChildAt(index))
    }
    structure?.let { for (index in 0 until it.windowNodeCount) visit(it.getWindowNodeAt(index).rootViewNode) }
    val intent = content?.intent
    val clip = content?.clipData
    val lines = listOf(
      "Window ${state.index + 1} of ${state.count}",
      "App: ${app?.let { context.packageManager.getApplicationLabel(it) } ?: "?"} (${packageName ?: "?"})",
      "Activity: ${structure?.activityComponent?.className ?: "?"}",
      "Category: ${category ?: "none"}",
      "Window titles: ${titles?.filterNotNull()?.filter(String::isNotBlank)?.joinToString(" | ")?.ifEmpty { null } ?: "none"}",
      "Web URI: ${content?.webUri ?: "none"}${if (content?.isAppProvidedWebUri == true) " (from the app)" else ""}",
      "Web domains: ${domains.joinToString(", ").ifEmpty { "none" }}",
      "Intent: ${intent?.let { "action=${it.action}, data=${it.data}, type=${it.type}" } ?: "none"}${if (content?.isAppProvidedIntent == true) " (from the app)" else ""}",
      "Clip data: ${clip?.let { data -> (0 until data.itemCount).joinToString(" | ") { index -> data.getItemAt(index).let { item -> item.uri?.toString() ?: item.text?.toString()?.take(CLIP_PREVIEW_CHARS) ?: "?" } } } ?: "none"}",
      "Clip type: ${clip?.description?.let { description -> (0 until description.mimeTypeCount).joinToString(", ") { description.getMimeType(it) } } ?: "none"}",
      "Structured data: ${content?.structuredData?.take(MAX_STRUCTURED_DATA_CHARS) ?: "none"}",
      "Content extras: ${content?.extras?.keySet()?.joinToString(", ")?.ifEmpty { null } ?: "none"}",
      "View classes: ${classes.entries.sortedByDescending { it.value }.take(TOP_VIEW_CLASSES).joinToString(", ") { "${it.key.substringAfterLast('.')} ×${it.value}" }}",
    )
    return lines.joinToString("\n")
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
    const val MAX_STRUCTURED_DATA_CHARS = 2_000
    const val CLIP_PREVIEW_CHARS = 120
    const val TOP_VIEW_CLASSES = 12
  }
}
