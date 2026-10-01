package com.plagnito.toulouseville;
import android.app.*;
import android.appwidget.*;
import android.content.*;
import android.widget.RemoteViews;
import org.json.*;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

public final class DeparturesWidget extends AppWidgetProvider {
    static final String REFRESH="com.plagnito.toulouseville.WIDGET_REFRESH";
    @Override public void onUpdate(Context c,AppWidgetManager m,int[] ids){for(int id:ids)update(c,id);RefreshJobs.sync(c);RefreshJobs.now(c);}
    @Override public void onReceive(Context c,Intent intent){super.onReceive(c,intent);if(REFRESH.equals(intent.getAction())){updateAll(c);RefreshJobs.now(c);}}
    @Override public void onDeleted(Context c,int[] ids){PersonalStore s=new PersonalStore(c);for(int id:ids)s.prefs.edit().remove("widget_"+id).apply();RefreshJobs.sync(c);}
    @Override public void onDisabled(Context c){RefreshJobs.sync(c);}
    static void updateAll(Context c){for(int id:AppWidgetManager.getInstance(c).getAppWidgetIds(new ComponentName(c,DeparturesWidget.class)))update(c,id);}
    static RemoteViews views(Context c,int widget){
        PersonalStore store=new PersonalStore(c);String id=store.prefs.getString("widget_"+widget,"");JSONObject stop=store.object("stops").optJSONObject(id),data=store.object("departure_"+id);String name=stop==null?"Choisir un arrêt favori":stop.optString("name");
        StringBuilder rows=new StringBuilder();JSONArray departures=data.optJSONArray("departures");long now=System.currentTimeMillis()/1000,fetched=data.optLong("fetched_ms");
        boolean same=store.apiBase(c).equals(data.optString("api_base"));
        boolean fresh=same&&fetched>0&&System.currentTimeMillis()-fetched<=180000&&TransitRules.fresh(data.optLong("rt_timestamp"),now)&&!data.optBoolean("stale");
        for(int i=0;same&&departures!=null&&i<departures.length()&&i<3;i++){JSONObject d=departures.optJSONObject(i);if(d!=null)rows.append(d.optString("line")).append(" → ").append(d.optString("destination")).append("\n").append(time(d.optLong("time")*1000)).append(d.optString("source").equals("rt")?" · prévision au relevé":" · horaire théorique").append("\n");}
        if(rows.length()==0)rows.append(id.isEmpty()?"Ajoute un arrêt depuis Tisséo.":fetched==0?"Actualiser pour consulter les passages.":"Aucun passage au relevé consulté.");
        String stamp=fetched==0||!same?"Aucun relevé consulté":"Relevé du "+Instant.ofEpochMilli(fetched).atZone(GeoRules.PARIS).format(DateTimeFormatter.ofPattern("d MMM HH:mm",Locale.FRENCH))+" · vérifier avant de partir";
        String error=store.prefs.getString("departure_error_"+id,"");if(!error.isEmpty())stamp=error+"\n"+stamp;
        RemoteViews view=new RemoteViews(c.getPackageName(),R.layout.departures_widget);view.setTextViewText(R.id.widget_name,name);view.setTextViewText(R.id.widget_departures,rows.toString().trim());view.setTextViewText(R.id.widget_stamp,stamp);
        Intent open=new Intent(c,MainActivity.class).putExtra("open_stop",id).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);view.setOnClickPendingIntent(R.id.widget_body,PendingIntent.getActivity(c,widget,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE));
        Intent refresh=new Intent(c,DeparturesWidget.class).setAction(REFRESH);view.setOnClickPendingIntent(R.id.widget_refresh,PendingIntent.getBroadcast(c,widget,refresh,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE));return view;
    }
    static void update(Context c,int id){AppWidgetManager.getInstance(c).updateAppWidget(id,views(c,id));}
    static String time(long ms){return Instant.ofEpochMilli(ms).atZone(GeoRules.PARIS).format(DateTimeFormatter.ofPattern("HH:mm",Locale.FRENCH));}
}
