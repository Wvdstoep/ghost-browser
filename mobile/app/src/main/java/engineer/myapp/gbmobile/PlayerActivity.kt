package engineer.myapp.gbmobile

import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.MediaController
import android.widget.Toast
import android.widget.VideoView

/**
 * THE RECORDING PLAYER — a full-screen VideoView for a recording's stream (the HLS playlist while it
 * records, the mp4 after), carrying the cluster session's cookie so Ghost Browser lets it through.
 * VideoView plays HLS and seeks an mp4 served with Range; a MediaController gives play/pause/seek.
 * Every error lands as a toast, never a crash.
 */
class PlayerActivity : Activity() {
    private var video: VideoView? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra("url") ?: run { finish(); return }
        val cookie = intent.getStringExtra("cookie") ?: ""
        val title = intent.getStringExtra("title") ?: "Recording"
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        val v = VideoView(this); video = v
        v.setBackgroundColor(0xFF000000.toInt())
        setContentView(v)
        val mc = MediaController(this); mc.setAnchorView(v); v.setMediaController(mc)
        val headers = HashMap<String, String>(); if (cookie.isNotBlank()) headers["Cookie"] = cookie
        try {
            v.setVideoURI(Uri.parse(url), headers)
            v.setOnPreparedListener { mp -> try { mp.start() } catch (e: Exception) { toast("Could not start: ${e.message}") } }
            v.setOnErrorListener { _, what, extra -> toast("Could not play $title ($what/$extra)"); finish(); true }
            v.setOnCompletionListener { finish() }
            v.requestFocus()
        } catch (e: Exception) { toast("Could not play $title: ${e.message}"); finish() }
    }
    private fun toast(s: String) { try { Toast.makeText(this, s, Toast.LENGTH_LONG).show() } catch (e: Exception) {} }
    override fun onPause() { try { video?.pause() } catch (e: Exception) {}; super.onPause() }
    override fun onDestroy() { try { video?.stopPlayback() } catch (e: Exception) {}; super.onDestroy() }
}
