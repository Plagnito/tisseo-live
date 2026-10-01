package com.plagnito.toulouseville;
import android.app.*;
import android.app.job.*;
import android.appwidget.AppWidgetManager;
import android.content.*;
import android.text.Html;
import org.json.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;

public final class RefreshService extends JobService {
    private final ExecutorService executor=Executors.newSingleThreadExecutor();
    private final Map<Integer,Future<?>> tasks=new HashMap<>();
    @Override public boolean onStartJob(JobParameters params){
        tasks.put(params.getJobId(),executor.submit(()->{try{refresh();}catch(Exception ignored){}if(!Thread.currentThread().isInterrupted())jobFinished(params,false);}));return true;
    }
    @Override public boolean onStopJob(JobParameters params){Future<?> task=tasks.remove(params.getJobId());if(task!=null)task.cancel(true);return true;}
    @Override public void onDestroy(){executor.shutdownNow();super.onDestroy();}
    private void refresh()throws Exception{
        PersonalStore store=new PersonalStore(this);String base=store.apiBase(this);Api api=new Api(base);
        int[] widgets=AppWidgetManager.getInstance(this).getAppWidgetIds(new ComponentName(this,DeparturesWidget.class));Set<String> stops=new LinkedHashSet<>();
        for(int widget:widgets){String id=store.prefs.getString("widget_"+widget,"");if(!id.isEmpty())stops.add(id);}
        for(String stop:stops){if(Thread.currentThread().isInterrupted())return;try{JSONObject result=api.get("/api/departures?stop_id="+Api.q(stop));if(Thread.currentThread().isInterrupted())return;if(!base.equals(store.apiBase(this)))return;result.put("fetched_ms",System.currentTimeMillis()).put("api_base",base);store.put("departure_"+stop,result);store.prefs.edit().remove("departure_error_"+stop).apply();}catch(Exception e){store.prefs.edit().putString("departure_error_"+stop,"Connexion indisponible · relevé ancien").apply();}}
        DeparturesWidget.updateAll(this);
        if(Thread.currentThread().isInterrupted()||!store.alertsEnabled()||!RefreshJobs.notificationAllowed(this))return;
        JSONObject lines=store.object("lines");if(lines.length()==0)return;long epoch=store.prefs.getLong("alert_epoch",0);
        JSONObject feed=api.get("/api/alerts");long now=System.currentTimeMillis()/1000;
        if(!TransitRules.fresh(feed.optLong("rt_timestamp"),now))return;
        JSONArray alerts=feed.optJSONArray("alerts");if(alerts==null)return;
        int hour=ZonedDateTime.now(GeoRules.PARIS).getHour();boolean window=TransitRules.withinHours(hour,store.prefs.getInt("alert_from",8),store.prefs.getInt("alert_to",22));
        JSONObject previous=store.object("alert_state"),next=new JSONObject();List<String> messages=new ArrayList<>();Iterator<String> ids=lines.keys();
        while(ids.hasNext()){
            String line=ids.next();Map<String,String> current=new HashMap<>();Map<String,String> titles=new HashMap<>();
            for(int i=0;i<alerts.length();i++){
                JSONObject alert=alerts.optJSONObject(i);if(alert==null||!includes(alert.optJSONArray("routes"),line))continue;
                List<long[]> periods=new ArrayList<>();List<String> times=new ArrayList<>();JSONArray published=alert.optJSONArray("active_period");
                if(published!=null)for(int k=0;k<published.length();k++){JSONObject p=published.optJSONObject(k);if(p!=null){long from=p.optLong("start"),to=p.optLong("end");periods.add(new long[]{from,to});times.add(from+"-"+to);}}
                if(!TransitRules.active(now,periods))continue;
                String title=plain(alert.optString("title")),description=plain(alert.optString("description"));String key=alert.optString("id");
                if(key.isEmpty())key=TransitRules.fingerprint(title,"",alert.optString("url"),0,Collections.emptyList());
                current.put(key,TransitRules.fingerprint(title,description,alert.optString("url"),alert.optInt("severity"),times));titles.put(key,title);
            }
            TransitRules.Delta delta=TransitRules.changes(previous.has(line)?map(previous.optJSONObject(line)):null,current,window);
            next.put(line,new JSONObject(delta.next));for(String key:delta.changed)messages.add(lines.optJSONObject(line).optString("name",line)+" · "+titles.get(key));
        }
        if(Thread.currentThread().isInterrupted()||!store.alertsEnabled()||epoch!=store.prefs.getLong("alert_epoch",0)||!base.equals(store.apiBase(this)))return;
        if(!messages.isEmpty()){
            NotificationManager manager=getSystemService(NotificationManager.class);manager.createNotificationChannel(new NotificationChannel("chosen_alerts","Perturbations des lignes choisies",NotificationManager.IMPORTANCE_DEFAULT));
            PendingIntent open=PendingIntent.getActivity(this,41,new Intent(this,MainActivity.class).putExtra("open_personal","alerts").addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
            Notification notification=new Notification.Builder(this,"chosen_alerts").setSmallIcon(R.drawable.ic_city).setContentTitle(messages.size()==1?"Tisséo · perturbation modifiée":"Tisséo · "+messages.size()+" changements").setContentText(messages.get(0)).setStyle(new Notification.BigTextStyle().bigText(String.join("\n",messages))).setContentIntent(open).setAutoCancel(true).build();
            try{manager.notify(4201,notification);}catch(SecurityException e){return;}
        }
        store.put("alert_state",next);store.prefs.edit().putLong("alerts_checked_ms",System.currentTimeMillis()).apply();
    }
    private static boolean includes(JSONArray a,String value){for(int i=0;a!=null&&i<a.length();i++)if(value.equals(a.optString(i)))return true;return false;}
    private static Map<String,String> map(JSONObject object){Map<String,String> m=new HashMap<>();if(object!=null){Iterator<String> keys=object.keys();while(keys.hasNext()){String key=keys.next();m.put(key,object.optString(key));}}return m;}
    private static String plain(String html){return Html.fromHtml(html,Html.FROM_HTML_MODE_LEGACY).toString().trim();}
}
