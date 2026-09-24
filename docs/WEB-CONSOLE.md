# The web console

The console at the root of a Ghost Browser instance is the shared Compose UI (gb-mobile, module
shared, target wasmJs), the same screens as the phone and the desktop. The bundle is built with
gradlew :shared:wasmJsBrowserDistribution and is NOT in this repository: the deployer copies it from
/home/carla/gb.new/public/console into the image, with the loader index.html that points at it.

Since 24 Sep 2026 the console has a sign-in gate: with no session it shows the shared SignInGate
(email + the password set on the instance, or the platform hand-off), never an empty console. Its
Settings page is SettingsScreenShared, where the password is set.
