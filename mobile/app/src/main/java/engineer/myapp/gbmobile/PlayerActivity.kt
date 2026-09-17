package engineer.myapp.gbmobile

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView

/**
 * THE RECORDING PLAYER — Media3/ExoPlayer in a full-screen PlayerView: the live HLS playlist while a
 * recording runs, the seekable mp4 after (served with Range). The URL carries the recording's ticket,
 * so no session cookie is needed; the one given still rides along. Real controls, real buffering
 * state, and a real error line instead of a black screen.
 */
@UnstableApi
class PlayerActivity : Activity() {
    private var player: ExoPlayer? = null
    private var status: TextView? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra("url") ?: run { finish(); return }
        val cookie = intent.getStringExtra("cookie") ?: ""
        val title = intent.getStringExtra("title") ?: "Recording"
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        val root = FrameLayout(this).apply { setBackgroundColor(0xFF000000.toInt()) }
        val view = PlayerView(this).apply { useController = true; controllerShowTimeoutMs = 3500; setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS) }
        val st = TextView(this).apply { setTextColor(0xFFFFFFFF.toInt()); textSize = 13f; setPadding(24, 24, 24, 24); text = "Loading $title…" }
        status = st
        root.addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        root.addView(st, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        setContentView(root)
        try {
            val http = DefaultHttpDataSource.Factory().setUserAgent("GhostBrowser/1.0 (Android)").setAllowCrossProtocolRedirects(true).setConnectTimeoutMs(20000).setReadTimeoutMs(60000)
            if (cookie.isNotBlank()) http.setDefaultRequestProperties(mapOf("Cookie" to cookie))
            val p = ExoPlayer.Builder(this).setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(http)).build()
            player = p; view.player = p
            p.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    st.text = when (state) { Player.STATE_BUFFERING -> "Buffering $title…"; Player.STATE_READY -> ""; Player.STATE_ENDED -> "Ended"; else -> st.text }
                    st.visibility = if (st.text.isNullOrBlank()) View.GONE else View.VISIBLE
                }
                override fun onPlayerError(error: PlaybackException) {
                    val why = (error.cause?.message ?: error.message ?: "unknown error").take(160)
                    st.text = "Could not play $title\n$why"; st.visibility = View.VISIBLE
                    toast("Could not play: $why")
                }
            })
            p.setMediaItem(MediaItem.fromUri(url)); p.prepare(); p.playWhenReady = true
        } catch (e: Throwable) { st.text = "Could not play $title: ${e.message}"; toast("Could not play $title: ${e.message}") }
    }
    private fun toast(s: String) { try { Toast.makeText(this, s, Toast.LENGTH_LONG).show() } catch (e: Exception) {} }
    override fun onPause() { try { player?.pause() } catch (e: Exception) {}; super.onPause() }
    override fun onDestroy() { try { player?.release() } catch (e: Exception) {}; player = null; super.onDestroy() }
}
