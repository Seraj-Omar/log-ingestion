export interface LogCursor{
    timestamp:string;
    id:string;
}

export function encodeCursor(cursor:LogCursor):string{
    const payload=JSON.stringify(cursor);
    return Buffer.from(payload,"utf8").toString("base64url");
}

export function decodeCursor(value:string):LogCursor{
    try{
        const decoded=Buffer.from(value,"base64url").toString("utf8");
        const parsed:unknown=JSON.parse(decoded);

        if(typeof parsed!=="object"||parsed==null||!("timestamp" in parsed)||!("id" in parsed)){
            throw new Error();
        }

        const {timestamp,id}=parsed as {timestamp?:unknown,id?:unknown};
        if(typeof timestamp!=="string"||Number.isNaN(Date.parse(timestamp))||typeof id!=="string"||!/^\d+$/.test(id)){
            throw new Error();
        }

        return {timestamp,id};
    }
    catch{
        throw new Error("invalid cursor");
    }
}
