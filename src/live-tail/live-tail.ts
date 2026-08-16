import type { ValidLog } from "../schemas/log.js";

type TailSubscriber=(logs:readonly ValidLog[])=>void;

export class LiveTail{
    private readonly subscribers=new Set<TailSubscriber>();

    public subscribe(subscriber:TailSubscriber):()=>void{
        this.subscribers.add(subscriber);
        
        return ()=>{this.subscribers.delete(subscriber)};
    }

    public publish(logs:readonly ValidLog[]):void{
        if(logs.length===0||this.subscribers.size===0){
            return;
        }

        for(const subscriber of this.subscribers){
            try{
                subscriber(logs);
            }catch{
                this.subscribers.delete(subscriber);
            }
        }
    }

    public subscriberCount():number{
        return this.subscribers.size;
    }
}

export const liveTail=new LiveTail();