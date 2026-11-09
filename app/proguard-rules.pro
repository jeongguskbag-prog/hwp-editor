# WebView 에서 부르는 함수(@JavascriptInterface) 는 이름을 바꾸거나 지우면 안 됨
-keepclassmembers class com.jeongguskbag.hwpeditor.MainActivity$Host {
    @android.webkit.JavascriptInterface <methods>;
}
