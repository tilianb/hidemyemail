# kotlinx.serialization — keep generated serializers for our API models.
-keepclassmembers class dev.hidemyemail.app.net.** {
    *** Companion;
}
-keepclasseswithmembers class dev.hidemyemail.app.net.** {
    kotlinx.serialization.KSerializer serializer(...);
}
