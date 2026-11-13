CREATE TABLE "locations" (
	"pin_code" varchar(10) PRIMARY KEY NOT NULL,
	"city" varchar(100) NOT NULL,
	"state" varchar(100) NOT NULL,
	"country" varchar(100) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_locations" (
	"id" integer PRIMARY KEY NOT NULL,
	"location_id" integer,
	"kam_id" integer,
	"is_active" boolean NOT NULL,
	"created_at" timestamp NOT NULL,
	"created_by" integer NOT NULL,
	"last_updated_at" timestamp,
	"last_updated_by" integer
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"client_id" integer PRIMARY KEY NOT NULL,
	"company_name" varchar(100) NOT NULL,
	"registered_address" varchar(200),
	"location_id" integer,
	"pin_code" varchar(10),
	"phone_number" varchar(20),
	"web_site_url" varchar(100),
	"pan" varchar(10),
	"tan" varchar(20),
	"tin" varchar(20),
	"gst" varchar(20),
	"is_active" boolean NOT NULL,
	"prefix_auction_code" varchar(30),
	"plant_tech_person_details" varchar(200),
	"auto_extend" boolean NOT NULL,
	"extend_in_sec" smallint,
	"extend_duration" smallint,
	"extension_no_of_times" smallint,
	"staggering_of_lots" smallint NOT NULL,
	"staggering_of_lots_duration" smallint NOT NULL,
	"staggering_of_auction" boolean NOT NULL,
	"staggering_of_auction_duration" smallint NOT NULL,
	"tnc" "bytea",
	"other_charge_is_percentage" boolean,
	"other_charge_amount" numeric(18, 2),
	"revenue_rate" numeric(18, 4),
	"created_at" timestamp NOT NULL,
	"created_by" integer NOT NULL,
	"last_updated_at" timestamp,
	"last_updated_by" integer
);
