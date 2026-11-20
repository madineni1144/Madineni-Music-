# Samsung tablet kiosk installation

This APK displays the production Madineni Music website in an Android WebView. It does not replace Android firmware. Internet access and a working HTTPS site are required.

## Build
GitHub Actions -> **Build Samsung Tablet Kiosk APK** -> Run workflow. Download the artifact ZIP and extract the debug APK.

## Install
1. Back up tablet data. Do not factory-reset until you have confirmed you can restore everything.
2. On the tablet enable Developer options (tap Build number seven times), then USB debugging.
3. On a computer with Android Platform Tools installed, connect tablet by USB and accept the debugging prompt.
4. Run `adb devices` and then `adb install -r tablet-kiosk-debug.apk`.
5. Open Madineni Music and select it as the default Home app if prompted. This gives auto-launch on Home but is **not** a secure lock-down.

## Optional dedicated-device lockdown (advanced)
Device-owner provisioning is intrusive and often requires a fresh or reset device without accounts. Only perform it on a tablet you own and have backed up. Android/Samsung may reject provisioning on an already configured device.

After installing the APK on an eligible fresh device, run:
```sh
adb shell dpm set-device-owner xyz.madineni.music.kiosk/.AdminReceiver
adb shell am start -n xyz.madineni.music.kiosk/.MainActivity
```
On successful provisioning, the app allowlists itself and enters lock task mode. Without device owner, it remains a normal Home launcher. Do not attempt to remove the device-owner app by simply uninstalling it. Test recovery and admin removal in a lab device before deployment.

## Network
Connect the tablet to a Wi-Fi network with internet access; HTTPS to madinenimusic.madineni.xyz must work. No special SSID is required. GitHub is for building updates, not streaming music.
