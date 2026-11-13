import { pgTable, integer, varchar, boolean, timestamp, real, customType, smallint, numeric, uniqueIndex, foreignKey, primaryKey, unique, check } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const bidders = pgTable("bidders", {
	bidderId: integer("bidder_id").primaryKey(),
	companyName: varchar("company_name", { length: 100 }).notNull(),
	address: varchar({ length: 1000 }),
	locationId: integer("location_id").references(() => locations.id),
	pincode: varchar({ length: 6 }),
	phone: varchar({ length: 20 }),
	website: varchar({ length: 100 }),
	email: varchar({ length: 250 }),
	pan: varchar({ length: 10 }),
	tin: varchar({ length: 20 }),
	cstVat: varchar("cst_vat", { length: 15 }),
	gstin: varchar({ length: 15 }),
	gstStatus: varchar("gst_status", { length: 500 }),
	gstValidatedAt: timestamp("gst_validated_at"),
	isActive: boolean("is_active").notNull(),
	approved: boolean().default(true).notNull(),
	isSupplier: boolean("is_supplier"),
	validFrom: timestamp("valid_from"),
	validTo: timestamp("valid_to"),
	emd: numeric({ mode: 'number', precision: 18, scale: 2 }).default(0),
	bidderScopeId: integer("bidder_scope_id"),
	remark: varchar({ length: 500 }),
	createdAt: timestamp("created_at").notNull(),
	updatedAt: timestamp("updated_at"),
	createdBy: integer("created_by").notNull().references(() => users.id),
	updatedBy: integer("updated_by").references(() => users.id),
}, (table) => [
check("bidders_emd_non_negative", sql`((emd IS NULL) OR (emd >= (0)::numeric))`),check("bidders_gstin_format", sql`((gstin IS NULL) OR ((gstin)::text ~* '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'::text))`),check("bidders_pan_format", sql`((pan IS NULL) OR ((pan)::text ~* '^[A-Z]{5}[0-9]{4}[A-Z]$'::text))`),check("bidders_pincode_format", sql`((pincode IS NULL) OR ((pincode)::text ~ '^[0-9]{6}$'::text))`),]);

export const clientLocations = pgTable("client_locations", {
	id: integer().primaryKey(),
	clientId: integer("client_id").notNull().references(() => clients.clientId),
	locationId: integer("location_id").references(() => locations.id),
	kamId: integer("kam_id"),
	isActive: boolean("is_active").notNull(),
	createdAt: timestamp("created_at").notNull(),
	createdBy: integer("created_by").notNull(),
	lastUpdatedAt: timestamp("last_updated_at"),
	lastUpdatedBy: integer("last_updated_by"),
});

export const clients = pgTable("clients", {
	clientId: integer("client_id").primaryKey(),
	companyName: varchar("company_name", { length: 100 }).notNull(),
	address: varchar({ length: 200 }),
	locationId: integer("location_id").references(() => locations.id),
	pincode: varchar({ length: 6 }),
	pan: varchar({ length: 10 }),
	tan: varchar({ length: 10 }),
	gstin: varchar({ length: 15 }),
	isActive: boolean("is_active").notNull(),
	phone: varchar({ length: 20 }),
	website: varchar({ length: 100 }),
	email: varchar({ length: 100 }),
	auctionPrefix: varchar("auction_prefix", { length: 30 }),
	revenueRate: real("revenue_rate"),
	autoExtend: boolean("auto_extend").notNull(),
	extendIfLastBid: smallint("extend_if_last_bid"),
	extendDuration: smallint("extend_duration"),
	extendFrequency: smallint("extend_frequency"),
	staggeringLots: boolean("staggering_lots").notNull(),
	staggeringLotsInterval: smallint("staggering_lots_interval").notNull(),
	staggeringAuction: boolean("staggering_auction").notNull(),
	staggeringAuctionInterval: smallint("staggering_auction_interval").notNull(),
	createdAt: timestamp("created_at").notNull(),
	updatedAt: timestamp("updated_at"),
	createdBy: integer("created_by").notNull().references(() => users.id),
	updatedBy: integer("updated_by").references(() => users.id),
}, (table) => [
check("clients_gstin_format", sql`((gstin IS NULL) OR ((gstin)::text ~* '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'::text))`),check("clients_pan_format", sql`((pan IS NULL) OR ((pan)::text ~* '^[A-Z]{5}[0-9]{4}[A-Z]$'::text))`),check("clients_pincode_format", sql`((pincode IS NULL) OR ((pincode)::text ~ '^[0-9]{6}$'::text))`),check("clients_revenue_rate_positive", sql`((revenue_rate IS NULL) OR (revenue_rate > (0)::double precision))`),check("clients_tan_format", sql`((tan IS NULL) OR ((tan)::text ~* '^[A-Z]{4}[0-9]{5}[A-Z]$'::text))`),]);

export const locations = pgTable("locations", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	country: varchar({ length: 100 }).notNull(),
	state: varchar({ length: 100 }).notNull(),
	city: varchar({ length: 100 }).notNull(),
}, (table) => [
	uniqueIndex("locations_country_state_city_uidx").using("btree", table.country.asc().nullsLast(), table.state.asc().nullsLast(), table.city.asc().nullsLast()),
]);

export const roles = pgTable("roles", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	code: varchar({ length: 32 }).notNull(),
	name: varchar({ length: 100 }).notNull(),
	description: varchar({ length: 500 }),
	isAdmin: boolean("is_admin").default(false).notNull(),
	createdAt: timestamp("created_at").default(sql`now()`).notNull(),
}, (table) => [
	unique("roles_code_key").on(table.code),]);

export const users = pgTable("users", {
	id: integer().primaryKey(),
	userLoginName: varchar("user_login_name", { length: 50 }).notNull(),
	name: varchar({ length: 100 }).notNull(),
	emailId: varchar("email_id", { length: 100 }),
	designation: varchar({ length: 100 }),
	uniqueId: varchar("unique_id", { length: 50 }),
	phoneNumber: varchar("phone_number", { length: 20 }),
	secondaryPhoneNumber: varchar("secondary_phone_number", { length: 20 }),
	whatsappNumber: varchar("whatsapp_number", { length: 20 }),
	whatsappSecNumber: varchar("whatsapp_sec_number", { length: 20 }),
	password: varchar({ length: 100 }).notNull(),
	previousPassword: varchar("previous_password", { length: 100 }),
	passwordChanged: boolean("password_changed").default(false).notNull(),
	passwordAlgo: varchar("password_algo", { length: 16 }).default("md5").notNull(),
	mpin: varchar({ length: 100 }),
	forgotPasswordOtp: varchar("forgot_password_otp", { length: 10 }),
	forgotPasswordOtpCreatedAt: timestamp("forgot_password_otp_created_at"),
	ndncAccepted: boolean("ndnc_accepted"),
	ndncUpdatedAt: timestamp("ndnc_updated_at"),
	isActive: boolean("is_active").default(true).notNull(),
	isOldDesign: boolean("is_old_design").default(false).notNull(),
	isLogin: boolean("is_login"),
	lastLoginAt: timestamp("last_login_at"),
	lastLogoutAt: timestamp("last_logout_at"),
	sessionId: varchar("session_id", { length: 100 }),
	sessionExpiresAt: timestamp("session_expires_at", { precision: 6 }),
	ipAddress: varchar("ip_address", { length: 50 }),
	token: varchar({ length: 100 }),
	tokenAt: timestamp("token_at"),
	createdAt: timestamp("created_at").notNull(),
	createdBy: integer("created_by").notNull(),
	lastUpdatedAt: timestamp("last_updated_at"),
	lastUpdatedBy: integer("last_updated_by"),
	roleId: integer("role_id").notNull().references(() => roles.id),
});
