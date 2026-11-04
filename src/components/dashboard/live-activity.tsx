"use client";

import {
  type ActivityEvent,
  useApiData,
  PageHeader,
  Button,
  Panel,
  ErrorNotice,
  ActivityList,
} from "./live-shared";
import styles from "./live-screens.module.css";

export function LiveActivityScreen() {
  const { data, error, loading, refresh } = useApiData<{ events: ActivityEvent[] }>(
    "/api/nanogres/activity",
  );
  return (
    <div className={styles.screen}>
      <PageHeader
        action={
          <Button onClick={() => void refresh()} variant="secondary">
            Refresh
          </Button>
        }
        description="A server-side record of database, role, and backup operations."
        eyebrow="AUDIT TRAIL"
        title="Activity"
      />
      <ErrorNotice error={error} onRetry={() => void refresh()} />
      <Panel title="Recent events" detail="Newest operations first">
        <ActivityList error={error} events={data?.events ?? []} loading={loading && !data} />
      </Panel>
    </div>
  );
}
