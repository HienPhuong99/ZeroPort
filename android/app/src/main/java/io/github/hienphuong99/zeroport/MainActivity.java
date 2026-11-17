package io.github.hienphuong99.zeroport;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

public class MainActivity extends BridgeActivity {
    private final Map<Integer, Sink> sinks = new ConcurrentHashMap<>();
    private final AtomicInteger nextId = new AtomicInteger(1);

    private static final class Sink {
        final OutputStream out;
        final Uri uri;
        final File file;
        Sink(OutputStream out, Uri uri, File file) { this.out = out; this.uri = uri; this.file = file; }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().addJavascriptInterface(new SaveBridge(), "zpAndroid");
        }
    }

    @Override
    public void onDestroy() {
        for (Sink s : sinks.values()) {
            try { s.out.close(); } catch (Exception ignored) {}
        }
        sinks.clear();
        super.onDestroy();
    }

    private final class SaveBridge {
        @JavascriptInterface
        public int saveOpen(String name, String mime) {
            String clean = (name == null ? "" : name).replaceAll("[/\\\\<>:\"|?*\\x00-\\x1f]", "_");
            if (clean.isEmpty() || ".".equals(clean) || "..".equals(clean)) clean = "file";
            String type = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, clean);
                    cv.put(MediaStore.Downloads.MIME_TYPE, type);
                    cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/ZeroPort");
                    cv.put(MediaStore.Downloads.IS_PENDING, 1);
                    ContentResolver cr = getContentResolver();
                    Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) return -1;
                    OutputStream os = cr.openOutputStream(uri);
                    if (os == null) { cr.delete(uri, null, null); return -1; }
                    int id = nextId.getAndIncrement();
                    sinks.put(id, new Sink(os, uri, null));
                    return id;
                }
                File dir = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "ZeroPort");
                if (!dir.exists() && !dir.mkdirs()) return -1;
                File target = uniqueFile(dir, clean);
                int id = nextId.getAndIncrement();
                sinks.put(id, new Sink(new FileOutputStream(target), null, target));
                return id;
            } catch (Exception e) {
                return -1;
            }
        }

        @JavascriptInterface
        public boolean saveWrite(int id, String b64Chunk) {
            Sink s = sinks.get(id);
            if (s == null || b64Chunk == null) return false;
            try {
                byte[] bytes = Base64.decode(b64Chunk, Base64.DEFAULT);
                s.out.write(bytes);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean saveClose(int id, boolean ok) {
            Sink s = sinks.remove(id);
            if (s == null) return false;
            try {
                if (ok) s.out.flush();
                s.out.close();
                if (s.uri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentResolver cr = getContentResolver();
                    if (ok) {
                        ContentValues cv = new ContentValues();
                        cv.put(MediaStore.Downloads.IS_PENDING, 0);
                        cr.update(s.uri, cv, null, null);
                    } else {
                        cr.delete(s.uri, null, null);
                    }
                } else if (!ok && s.file != null) {
                    //noinspection ResultOfMethodCallIgnored
                    s.file.delete();
                }
                return ok;
            } catch (Exception e) {
                return false;
            }
        }
    }

    private static File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; ; i++) {
            File cand = new File(dir, stem + " (" + i + ")" + ext);
            if (!cand.exists()) return cand;
        }
    }
}
