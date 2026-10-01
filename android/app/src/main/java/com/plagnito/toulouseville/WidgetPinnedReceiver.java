package com.plagnito.toulouseville;
import android.appwidget.AppWidgetManager;
import android.content.*;
public final class WidgetPinnedReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c,Intent intent){int id=intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,-1);String stop=intent.getStringExtra("stop_id");if(id<0||stop==null)return;PersonalStore store=new PersonalStore(c);if(!store.contains("stops",stop))return;store.prefs.edit().putString("widget_"+id,stop).apply();DeparturesWidget.update(c,id);RefreshJobs.sync(c);RefreshJobs.now(c);}
}
