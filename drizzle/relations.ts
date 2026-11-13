import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
	bidders: {
		userCreatedBy: r.one.users({
			from: r.bidders.createdBy,
			to: r.users.id,
			alias: "bidders_createdBy_users_id"
		}),
		location: r.one.locations({
			from: r.bidders.locationId,
			to: r.locations.id
		}),
		userUpdatedBy: r.one.users({
			from: r.bidders.updatedBy,
			to: r.users.id,
			alias: "bidders_updatedBy_users_id"
		}),
	},
	users: {
		biddersCreatedBy: r.many.bidders({
			alias: "bidders_createdBy_users_id"
		}),
		biddersUpdatedBy: r.many.bidders({
			alias: "bidders_updatedBy_users_id"
		}),
		clientsCreatedBy: r.many.clients({
			alias: "clients_createdBy_users_id"
		}),
		clientsUpdatedBy: r.many.clients({
			alias: "clients_updatedBy_users_id"
		}),
		role: r.one.roles({
			from: r.users.roleId,
			to: r.roles.id
		}),
	},
	locations: {
		bidders: r.many.bidders(),
		clientsViaClientLocations: r.many.clients({
			alias: "clients_clientId_locations_id_via_clientLocations"
		}),
		clientsLocationId: r.many.clients({
			alias: "clients_locationId_locations_id"
		}),
	},
	clients: {
		locations: r.many.locations({
			from: r.clients.clientId.through(r.clientLocations.clientId),
			to: r.locations.id.through(r.clientLocations.locationId),
			alias: "clients_clientId_locations_id_via_clientLocations"
		}),
		userCreatedBy: r.one.users({
			from: r.clients.createdBy,
			to: r.users.id,
			alias: "clients_createdBy_users_id"
		}),
		location: r.one.locations({
			from: r.clients.locationId,
			to: r.locations.id,
			alias: "clients_locationId_locations_id"
		}),
		userUpdatedBy: r.one.users({
			from: r.clients.updatedBy,
			to: r.users.id,
			alias: "clients_updatedBy_users_id"
		}),
	},
	roles: {
		users: r.many.users(),
	},
}))