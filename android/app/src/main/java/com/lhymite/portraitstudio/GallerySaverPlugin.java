package com.lhymite.portraitstudio;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/** Streams files from the WebView into the phone gallery (MediaStore) in chunks. */
@CapacitorPlugin(name = "GallerySaver")
public class GallerySaverPlugin extends Plugin {
    private static class Sink { OutputStream out; Uri uri; File file; String mime; }
    private final Map<String, Sink> sinks = new HashMap<>();
    private int next = 1;

    @PluginMethod
    public void open(PluginCall call) {
        String name = call.getString("name", "PortraitStudio_" + System.currentTimeMillis());
        String mime = call.getString("mime", "image/jpeg");
        boolean video = mime.startsWith("video/");
        boolean image = mime.startsWith("image/");
        try {
            Sink s = new Sink(); s.mime = mime;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                String dir = video ? Environment.DIRECTORY_MOVIES : image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS;
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, dir + "/PortraitStudio");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri col = video ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                        : image ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                        : MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                ContentResolver cr = getContext().getContentResolver();
                s.uri = cr.insert(col, v);
                if (s.uri == null) throw new Exception("Gallery refused the file");
                s.out = cr.openOutputStream(s.uri);
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES), "PortraitStudio");
                if (!dir.exists() && !dir.mkdirs()) {
                    dir = new File(getContext().getExternalFilesDir(video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES), "PortraitStudio");
                    dir.mkdirs();
                }
                s.file = new File(dir, name);
                s.out = new FileOutputStream(s.file);
            }
            String id = String.valueOf(next++);
            sinks.put(id, s);
            JSObject r = new JSObject(); r.put("id", id); call.resolve(r);
        } catch (Exception e) { call.reject("Could not create file: " + e.getMessage()); }
    }

    @PluginMethod
    public void write(PluginCall call) {
        Sink s = sinks.get(call.getString("id"));
        if (s == null) { call.reject("Unknown file"); return; }
        try { s.out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT)); call.resolve(); }
        catch (Exception e) { call.reject("Write failed: " + e.getMessage()); }
    }

    @PluginMethod
    public void close(PluginCall call) {
        Sink s = sinks.remove(call.getString("id"));
        if (s == null) { call.reject("Unknown file"); return; }
        try {
            s.out.flush(); s.out.close();
            JSObject r = new JSObject();
            if (s.uri != null) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContext().getContentResolver().update(s.uri, v, null, null);
                r.put("uri", s.uri.toString());
            } else if (s.file != null) {
                MediaScannerConnection.scanFile(getContext(), new String[]{s.file.getAbsolutePath()}, new String[]{s.mime}, null);
                r.put("uri", s.file.getAbsolutePath());
            }
            r.put("where", s.mime.startsWith("video/") ? "Gallery › Movies/PortraitStudio" : s.mime.startsWith("image/") ? "Gallery › Pictures/PortraitStudio" : "Downloads/PortraitStudio");
            call.resolve(r);
        } catch (Exception e) { call.reject("Finish failed: " + e.getMessage()); }
    }

    @PluginMethod
    public void abort(PluginCall call) {
        Sink s = sinks.remove(call.getString("id"));
        if (s != null) {
            try { s.out.close(); } catch (Exception ignored) { }
            try { if (s.uri != null) getContext().getContentResolver().delete(s.uri, null, null); if (s.file != null) s.file.delete(); } catch (Exception ignored) { }
        }
        call.resolve();
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }
}
