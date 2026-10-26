package engineer.myapp.gbmobile

import android.content.Context

/** A console cookie and a native device key are separate logins. Forget the key durably. */
object DeviceSignOut {
    fun clear(context: Context): Boolean = context.getSharedPreferences("gb", Context.MODE_PRIVATE).edit()
        .remove("clusterKey").remove("approvedCookieSync").remove("platformsCache")
        .remove("flowsCache").remove("rolesCache")
        .remove("signinState").remove("signinVerifier").remove("signinExpires").commit()
}
