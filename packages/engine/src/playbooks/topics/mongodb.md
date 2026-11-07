---
title: MongoDB data modelling
summary: Embed or reference, schema validation, indexes (ESR rule), transactions, pagination, Mongoose and Motor or PyMongo usage.
agents: database, backend, enhancement, coder
triggers: mongodb, mongo, mongoose, motor, pymongo, beanie, document database, nosql, atlas
---
# MongoDB data modelling

## Model for the queries
Design documents around how the app reads them. Rules of thumb:
- **Embed** data that belongs to the parent, is read with it and stays bounded: order line items, a user's addresses, a post's last 3 comments.
- **Reference** (store the `_id`) when the child grows without bound, is shared by many parents, or is updated independently: all comments of a post, users of an organisation, products in orders (copy the price and name into the order line at purchase time, since they must not change later).
- Never let an array grow forever: a document is capped at 16 MB and large arrays make every update slower. Use a separate collection or the bucket pattern (one document per user per day).
- Duplicate a little data for fast reads (for example the author name on a post) when it rarely changes, and update copies in the same code path.

## Schema validation
MongoDB is schemaless only if you let it be. Validate in the application (Mongoose schemas, Pydantic models with Beanie or ODMantic, Zod) and in the database:
```js
db.createCollection("bookings", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["userId", "doctorId", "startsAt", "status"],
    properties: {
      userId: { bsonType: "objectId" },
      doctorId: { bsonType: "objectId" },
      startsAt: { bsonType: "date" },
      status: { enum: ["pending", "confirmed", "cancelled"] },
      priceCents: { bsonType: "int", minimum: 0 }
    }
  } },
  validationAction: "error"
});
```

## Indexes
- Compound index order follows **ESR**: Equality fields first, then Sort fields, then Range fields. Query `{ doctorId, status: "confirmed", startsAt: { $gte: now } }` sorted by `startsAt`: index `{ doctorId: 1, status: 1, startsAt: 1 }`.
- Unique indexes for natural keys: `db.users.createIndex({ email: 1 }, { unique: true, collation: { locale: "en", strength: 2 } })` (case-insensitive).
- Partial indexes for subsets (`partialFilterExpression: { deletedAt: null }`), TTL indexes for expiring data (`{ expireAfterSeconds: 3600 }` on a date field: sessions, reset tokens).
- Check plans: `db.bookings.find(q).sort(s).explain("executionStats")`; look for `COLLSCAN` and `totalDocsExamined` far above `nReturned`.

## Writes and consistency
- Single-document writes are atomic: prefer designs where an invariant lives in one document and use operators (`$inc`, `$push` with `$slice`, `$set`) with a filter that encodes the rule: `updateOne({ _id, stock: { $gte: qty } }, { $inc: { stock: -qty } })` and check `modifiedCount`.
- Multi-document transactions need a replica set (a single-node replica set works locally: start mongod with `--replSet rs0` and run `rs.initiate()`). Keep them short.
- Duplicate key errors have code `11000`: map them to 409.

## Pagination
Avoid large `skip`. Use range queries on an indexed, unique sort key:
```js
db.bookings.find({ userId, _id: { $lt: lastSeenId } }).sort({ _id: -1 }).limit(20)
```
For other sort fields, combine the field and `_id` as the cursor.

## Mongoose (Node.js)
```ts
const BookingSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  doctorId: { type: Schema.Types.ObjectId, ref: "Doctor", required: true },
  startsAt: { type: Date, required: true },
  status: { type: String, enum: ["pending", "confirmed", "cancelled"], default: "pending" },
}, { timestamps: true });
BookingSchema.index({ doctorId: 1, startsAt: 1 }, { unique: true, partialFilterExpression: { status: { $ne: "cancelled" } } });
export const Booking = model("Booking", BookingSchema);
```
Use `.lean()` for read-only queries (plain objects, faster), `select()` to limit fields, and `populate()` sparingly (it is an extra query per path). Set `strictQuery` and never pass raw request bodies as filters: `{ email: req.body.email }` with a body of `{ "$ne": null }` is a NoSQL injection. Validate types first (Zod) or use `mongo-sanitize`.

## Python
Motor or PyMongo's async client for FastAPI (`AsyncMongoClient` in recent PyMongo), or an ODM such as Beanie (Pydantic models). Convert `ObjectId` to string in response models.

## Testing
Use a throwaway database per test run (`mongodb-memory-server` for Node, a docker `mongo:7` service otherwise), create indexes in test setup exactly as in production, and drop the database after the run.
