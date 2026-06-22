export type PublisherGroup = 'DC' | 'MARVEL' | 'OTROS';

export interface ReleaseRow {
  issue_id: number;
  series_id: number;
  issue_number: string;
  release_date: string;
  cover_url: string | null;
  price: string | null;
  series: {
    name: string;
    publishers: {
      name: string;
      publisher_group: PublisherGroup;
    };
  };
}
export type PullStatus = 'no_salido' | 'descargar' | 'listo' | 'pedido' | 'leido';
export type PullFormat = 'digital' | 'fisico';

export interface PullRow {
  id: string;
  issue_number: string;
  release_date: string;
  cover_url: string | null;
  format: PullFormat;
  status: PullStatus;
  series: {
    name: string;
    publishers: {
      name: string;
      publisher_group: PublisherGroup;
    };
  };
}

export interface SeriesResult {
  series_id: number;
  name: string;
  publishers: { name: string; publisher_group: PublisherGroup };
}

export interface PublisherOption {
  publisher_id: number;
  name: string;
  publisher_group: PublisherGroup;
}

export interface SyncLog {
  id: string;
  ran_at: string;
  status: 'ok' | 'error';
  message: string | null;
  releases_upserted: number | null;
}
