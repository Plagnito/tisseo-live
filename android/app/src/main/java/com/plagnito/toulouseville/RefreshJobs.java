package com.plagnito.toulouseville;
import android.app.*;
import android.app.job.*;
import android.appwidget.AppWidgetManager;
import android.content.*;

final class RefreshJobs {
    static final int PERIODIC=4101, MANUAL=4102;
    static boolean notificationAllowed(Context context){return context.getSystemService(NotificationManager.class).areNotificationsEnabled();}
    static void sync(Context context){
        JobScheduler scheduler=context.getSystemService(JobScheduler.class);
        PersonalStore store=new PersonalStore(context);
        boolean widgets=AppWidgetManager.getInstance(context).getAppWidgetIds(new ComponentName(context,DeparturesWidget.class)).length>0;
        boolean alerts=store.alertsEnabled()&&store.object("lines").length()>0&&notificationAllowed(context);
        if(!widgets&&!alerts){scheduler.cancel(PERIODIC);scheduler.cancel(MANUAL);return;}
        if(scheduler.getPendingJob(PERIODIC)==null)scheduler.schedule(new JobInfo.Builder(PERIODIC,new ComponentName(context,RefreshService.class)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true).setRequiresBatteryNotLow(true).setPeriodic(15*60_000L,5*60_000L).build());
    }
    static void now(Context context){context.getSystemService(JobScheduler.class).schedule(new JobInfo.Builder(MANUAL,new ComponentName(context,RefreshService.class)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).build());}
}
