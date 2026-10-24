export type PublisherGroup = 'DC' | 'MARVEL' | 'OTROS';

export interface ReleaseRow {
  issue_id: number;
  series_id: number;
  issue_number: string;
  release_date: string;
  cover_url: string | null;
  price: string | null;
  issue_type: string | null;
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
  /** false = el catálogo solo daba el mes ("Fecha por confirmar"). */
  date_confirmed: boolean;
  series: {
    name: string;
    publishers: {
      name: string;
      publisher_group: PublisherGroup;
    };
  };
}

/** Número solicitado en un catálogo de previews (tabla `previews`). */
export interface PreviewRow {
  id: string;
  publisher_id: number;
  item_key: string;
  series_name: string;
  issue_number: string;
  title: string;
  issue_type: string;
  release_date: string | null;
  release_month: string;
  price: number | null;
  catalog: string | null;
  publishers: { name: string; publisher_group: PublisherGroup };
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
