package com.lhymite.portraitstudio;

import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Free, on-device text to speech using the phone's own Android TTS engine, rendered to a WAV file. */
@CapacitorPlugin(name = "NativeTts")
public class NativeTtsPlugin extends Plugin {
    private TextToSpeech tts;
    private boolean ready = false;
    private final Map<String, PluginCall> pending = new HashMap<>();
    private final Map<String, File> files = new HashMap<>();

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> ready = status == TextToSpeech.SUCCESS);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { }
            @Override public void onDone(String id) { finish(id, null); }
            @Override public void onError(String id) { finish(id, "Speech engine error"); }
        });
    }

    private void finish(String id, String error) {
        PluginCall call = pending.remove(id); File f = files.remove(id);
        if (call == null) return;
        if (error != null || f == null) { call.reject(error != null ? error : "No audio"); return; }
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[(int) f.length()]; int off = 0, n;
            while (off < buf.length && (n = in.read(buf, off, buf.length - off)) > 0) off += n;
            JSObject r = new JSObject(); r.put("data", Base64.encodeToString(buf, Base64.NO_WRAP)); r.put("mime", "audio/wav");
            call.resolve(r);
        } catch (Exception e) { call.reject("Read failed: " + e.getMessage()); }
        finally { f.delete(); }
    }

    @PluginMethod
    public void synthesize(PluginCall call) {
        if (!ready) { call.reject("Text-to-speech engine is not ready. Install or enable a TTS engine in Android settings."); return; }
        String text = call.getString("text", "");
        if (text.isEmpty()) { call.reject("No text"); return; }
        String lang = call.getString("lang", "");
        if (!lang.isEmpty()) tts.setLanguage(Locale.forLanguageTag(lang));
        tts.setSpeechRate(call.getFloat("rate", 1f));
        tts.setPitch(call.getFloat("pitch", 1f));
        String id = "ps" + System.nanoTime();
        File f = new File(getContext().getCacheDir(), id + ".wav");
        pending.put(id, call); files.put(id, f);
        int r = tts.synthesizeToFile(text, new Bundle(), f, id);
        if (r != TextToSpeech.SUCCESS) { pending.remove(id); files.remove(id); call.reject("Speech synthesis failed"); }
    }

    @Override
    protected void handleOnDestroy() { if (tts != null) tts.shutdown(); }
}
